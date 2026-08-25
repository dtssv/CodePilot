package io.codepilot.harness.tool.builtin

/**
 * Pure Kotlin patch application engine.
 *
 * Sunk from plugin/tools/PatchApplier.kt (1650 lines). The original mixes IDE
 * concerns (WriteCommandAction / DiffManager / FileEditorManager / Messages)
 * with the patch-matching algorithms; here we keep only the algorithms so
 * they can be JVM-unit-tested without an IDE.
 *
 * Strategies, in order of escalation:
 *   1. [exactReplace]      — literal substring replace (regex/ignoreCase support)
 *   2. [lineTrimReplace]   — match on trim()'ed lines, preserve indentation
 *   3. [fuzzyReplace]      — contiguous block of trim-matched lines
 *   4. [subsequenceReplace]— monotonic assignment of search lines across original
 *   5. [applyUnifiedHunks] — classic unified diff @@ hunks
 *
 * Each strategy returns a [ReplaceResult] with the new text and the match count;
 * [applyBestEffort] runs them in escalation order until one succeeds.
 */
class PatchEngine {

    data class ReplaceResult(val text: String, val matches: Int) {
        val ok: Boolean get() = matches > 0
    }

    /**
     * Run replace strategies in escalation order. Returns the first success
     * or the original text with matches=0 if all fail.
     */
    fun applyBestEffort(
        original: String,
        search: String,
        replace: String,
        regex: Boolean = false,
        ignoreCase: Boolean = false,
        replaceAll: Boolean = false,
    ): ReplaceResult {
        // 1. exact (regex or literal)
        val exact = applyReplace(original, search, replace, regex, ignoreCase, replaceAll)
        if (exact.ok) return exact

        // 2. line-trim match (only when not regex — regex implies literal intent)
        if (!regex) {
            val lineTrim = lineTrimReplace(original, search, replace)
            if (lineTrim.ok) return lineTrim

            // 3. fuzzy contiguous
            val fuzzy = fuzzyReplace(original, search, replace)
            if (fuzzy.ok) return fuzzy

            // 4. subsequence
            val sub = subsequenceReplace(original, search, replace)
            if (sub.ok) return sub
        }
        return ReplaceResult(original, 0)
    }

    /** Apply a unified-diff patch to [original]; returns the new text. */
    fun applyUnifiedHunks(original: String, hunkText: String): String {
        val origLines = original.lines().toMutableList()
        val hunkLines = hunkText.lines()
        val result = mutableListOf<String>()
        var origIdx = 0

        for (line in hunkLines) {
            when {
                line.startsWith("@@") -> {
                    val match = Regex("@@ -(\\d+)").find(line)
                    val targetLine = (match?.groupValues?.get(1)?.toIntOrNull() ?: 1) - 1
                    while (origIdx < targetLine && origIdx < origLines.size) {
                        result.add(origLines[origIdx++])
                    }
                }
                line.startsWith("-") -> origIdx++ // skip removed line
                line.startsWith("+") -> result.add(line.substring(1))
                line.startsWith(" ") -> {
                    result.add(origLines.getOrElse(origIdx) { line.substring(1) })
                    origIdx++
                }
            }
        }
        while (origIdx < origLines.size) result.add(origLines[origIdx++])
        return result.joinToString("\n")
    }

    /**
     * Exact substring (or regex) replace.
     * When [replaceAll] is false, only the first occurrence is replaced.
     */
    fun applyReplace(
        original: String,
        search: String,
        replace: String,
        regex: Boolean,
        ignoreCase: Boolean,
        replaceAll: Boolean = true,
    ): ReplaceResult {
        val pattern = if (regex) {
            Regex(search, if (ignoreCase) setOf(RegexOption.IGNORE_CASE) else emptySet())
        } else {
            Regex(Regex.escape(search), if (ignoreCase) setOf(RegexOption.IGNORE_CASE) else emptySet())
        }
        var count = 0
        val replaced = if (replaceAll) {
            pattern.replace(original) { count++; replace }
        } else {
            val m = pattern.find(original)
            if (m != null) {
                count = 1
                buildString {
                    append(original, 0, m.range.first)
                    append(replace)
                    append(original, m.range.last + 1, original.length)
                }
            } else {
                original
            }
        }
        return ReplaceResult(replaced, count)
    }

    /**
     * Strategy 2: trim-equality match. Tolerates indentation depth and tab/space
     * differences by matching on trim()'ed lines, then re-indenting the replace
     * block to match the original's base indent.
     */
    fun lineTrimReplace(original: String, searchText: String, replaceText: String): ReplaceResult {
        val originalLines = original.lines()
        val searchLines = searchText.lines()
        if (searchLines.isEmpty()) return ReplaceResult(original, 0)

        val originalTrimmed = originalLines.map { it.trim() }.joinToString("\n")
        val searchTrimmed = searchLines.map { it.trim() }.joinToString("\n")

        // For safety, only proceed if exactly one match.
        val idx = originalTrimmed.indexOf(searchTrimmed)
        if (idx < 0) return ReplaceResult(original, 0)
        if (originalTrimmed.indexOf(searchTrimmed, idx + 1) >= 0) return ReplaceResult(original, 0)

        val startLine = originalTrimmed.substring(0, idx).count { it == '\n' }
        val endLine = startLine + searchLines.size - 1

        val matchedOriginalIndents = (startLine..endLine).map { i ->
            if (i < originalLines.size) originalLines[i].takeWhile { it == ' ' || it == '\t' } else ""
        }
        val searchIndents = searchLines.map { it.takeWhile { it == ' ' || it == '\t' } }
        val baseOriginalIndent = matchedOriginalIndents.firstOrNull() ?: ""
        val baseSearchIndent = searchIndents.firstOrNull() ?: ""

        val replaceRawLines = replaceText.lines()
        val indentedReplace = replaceRawLines.mapIndexed { i, line ->
            if (line.isBlank()) line
            else {
                val trimmed = line.trim()
                val matchedSearchIdx = searchLines.map { it.trim() }.indexOfFirst { it == trimmed }
                val searchLineIndent = if (matchedSearchIdx in searchIndents.indices) searchIndents[matchedSearchIdx]
                    else if (i in searchIndents.indices) searchIndents[i] else baseSearchIndent
                val relativeIndent = if (searchLineIndent.length >= baseSearchIndent.length)
                    searchLineIndent.substring(baseSearchIndent.length) else ""
                baseOriginalIndent + relativeIndent + trimmed
            }
        }
        val replacedLines = originalLines.toMutableList()
        replacedLines.subList(startLine, endLine + 1).clear()
        replacedLines.addAll(startLine, indentedReplace)
        return ReplaceResult(replacedLines.joinToString("\n"), 1)
    }

    /**
     * Strategy 3: fuzzy contiguous match. Find a contiguous block whose
     * trim()'ed lines equal the search's trim()'ed lines.
     */
    fun fuzzyReplace(original: String, searchText: String, replaceText: String): ReplaceResult {
        val searchTrimmed = searchText.lines().map { it.trim() }
        if (searchTrimmed.isEmpty()) return ReplaceResult(original, 0)

        val originalLines = original.lines()
        val originalTrimmed = originalLines.map { it.trim() }

        var matchStart = -1
        var matchCount = 0
        for (i in originalTrimmed.indices) {
            val end = minOf(i + searchTrimmed.size, originalTrimmed.size)
            if (originalTrimmed.subList(i, end) == searchTrimmed) {
                matchStart = i
                matchCount++
            }
        }
        if (matchStart == -1) return ReplaceResult(original, 0)

        val searchRaw = searchText.lines()
        val replaceRaw = replaceText.lines()
        val baseIndent = originalLines[matchStart].takeWhile { it == ' ' || it == '\t' }
        val searchBaseIndent = searchRaw.firstOrNull()?.takeWhile { it == ' ' || it == '\t' } ?: ""

        val indentedReplace = replaceRaw.mapIndexed { i, line ->
            if (line.isBlank()) line
            else {
                val trimmed = line.trim()
                val matchedSearchIdx = searchTrimmed.indexOfFirst { it == trimmed }
                val searchLineIndent = if (matchedSearchIdx in searchRaw.indices) searchRaw[matchedSearchIdx].takeWhile { it == ' ' || it == '\t' }
                    else if (i in searchRaw.indices) searchRaw[i].takeWhile { it == ' ' || it == '\t' }
                    else searchBaseIndent
                val relativeIndent = if (searchLineIndent.length >= searchBaseIndent.length)
                    searchLineIndent.substring(searchBaseIndent.length) else ""
                baseIndent + relativeIndent + trimmed
            }
        }
        val replacedLines = originalLines.toMutableList()
        replacedLines.subList(matchStart, matchStart + searchTrimmed.size).clear()
        replacedLines.addAll(matchStart, indentedReplace)
        return ReplaceResult(replacedLines.joinToString("\n"), matchCount)
    }

    /**
     * Strategy 4: subsequence match. Map each non-blank search line (after trim)
     * to original lines via a tight monotonic assignment, then replace the whole span.
     * Tolerates LLM "simplified" search blocks that skip unrelated lines.
     */
    fun subsequenceReplace(original: String, searchText: String, replaceText: String): ReplaceResult {
        val searchTrimmed = searchText.lines().map { it.trim() }
        if (searchTrimmed.size < 3) return ReplaceResult(original, 0)

        val originalLines = original.lines()
        val originalTrimmed = originalLines.map { it.trim() }

        val nonBlankIdxs = searchTrimmed.indices.filter { !searchTrimmed[it].isBlank() }
        if (nonBlankIdxs.isEmpty()) return ReplaceResult(original, 0)

        val candidates = nonBlankIdxs.map { sIdx ->
            val sLine = searchTrimmed[sIdx]
            originalTrimmed.indices.filter { originalTrimmed[it] == sLine }
        }
        val greedy = greedyMonotonicAssign(candidates) ?: return ReplaceResult(original, 0)
        val tightened = tightenAssignment(candidates, greedy)

        val matchedCount = tightened.count { it >= 0 }
        val matchRatio = matchedCount.toDouble() / nonBlankIdxs.size
        if (matchRatio < 0.6 || matchedCount < 3) return ReplaceResult(original, 0)

        val valid = tightened.filter { it >= 0 }
        if (valid.isEmpty()) return ReplaceResult(original, 0)
        val spanStart = valid.first()
        val spanEnd = valid.last()
        val spanWidth = spanEnd - spanStart + 1
        if (spanWidth > searchTrimmed.size * 3) return ReplaceResult(original, 0)

        val searchRaw = searchText.lines()
        val searchBaseIndent = searchRaw.firstOrNull()?.takeWhile { it == ' ' || it == '\t' } ?: ""
        val baseIndent = originalLines[spanStart].takeWhile { it == ' ' || it == '\t' }
        val indentedReplace = replaceText.lines().mapIndexed { i, line ->
            if (line.isBlank()) line
            else {
                val trimmed = line.trim()
                val matchedSearchIdx = searchTrimmed.indexOfFirst { it == trimmed }
                val searchLineIndent = if (matchedSearchIdx in searchRaw.indices)
                    searchRaw[matchedSearchIdx].takeWhile { it == ' ' || it == '\t' }
                else if (i in searchRaw.indices) searchRaw[i].takeWhile { it == ' ' || it == '\t' }
                else searchBaseIndent
                val relativeIndent = if (searchLineIndent.length >= searchBaseIndent.length)
                    searchLineIndent.substring(searchBaseIndent.length) else ""
                baseIndent + relativeIndent + trimmed
            }
        }
        val replacedLines = originalLines.toMutableList()
        replacedLines.subList(spanStart, spanEnd + 1).clear()
        replacedLines.addAll(spanStart, indentedReplace)
        return ReplaceResult(replacedLines.joinToString("\n"), 1)
    }

    /**
     * Greedy monotonic assignment: pick the earliest candidate > lastIdx for
     * each search line, preserving strict monotonicity. Returns null if
     * monotonicity cannot be maintained or fewer than 3 lines match.
     */
    private fun greedyMonotonicAssign(candidates: List<List<Int>>): IntArray? {
        val assignment = IntArray(candidates.size) { -1 }
        var lastIdx = -1
        for (i in candidates.indices) {
            if (candidates[i].isEmpty()) continue
            val chosen = candidates[i].firstOrNull { it > lastIdx } ?: return null
            assignment[i] = chosen
            lastIdx = chosen
        }
        if (assignment.count { it >= 0 } < 3) return null
        return assignment
    }

    /**
     * Tighten from right to left: shift each assignment to the latest candidate
     * that stays below the next valid assignment, producing a tighter span.
     */
    private fun tightenAssignment(candidates: List<List<Int>>, greedy: IntArray): IntArray {
        val result = greedy.copyOf()
        for (i in (candidates.size - 2) downTo 0) {
            if (candidates[i].isEmpty() || result[i] < 0) continue
            var upperBound = Int.MAX_VALUE
            for (j in (i + 1) until candidates.size) {
                if (result[j] >= 0) { upperBound = result[j]; break }
            }
            if (upperBound == Int.MAX_VALUE) continue
            var lowerBound = -1
            for (j in 0 until i) if (result[j] >= 0) lowerBound = result[j]
            val best = candidates[i].lastOrNull { it > lowerBound && it < upperBound }
            if (best != null) result[i] = best
        }
        return result
    }
}
