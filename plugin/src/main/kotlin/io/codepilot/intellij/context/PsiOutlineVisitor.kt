package io.codepilot.intellij.context

import com.intellij.psi.JavaRecursiveElementVisitor
import com.intellij.psi.PsiClass
import com.intellij.psi.PsiImportStatement
import com.intellij.psi.PsiMethod
import com.intellij.psi.PsiField

/**
 * Walks a Java PSI tree to extract class/method signatures for context summaries.
 * Used by [ContextCollector] to build lightweight file outlines for large files.
 */
class PsiOutlineVisitor : JavaRecursiveElementVisitor() {

    var topLevelKind: String? = null
        private set
    var topLevelName: String? = null
        private set
    var topLevelSignature: String? = null
        private set
    var imports: List<String> = emptyList()
        private set

    private val importList = mutableListOf<String>()

    override fun visitImportStatement(statement: PsiImportStatement) {
        importList.add(statement.qualifiedName ?: "")
        super.visitImportStatement(statement)
    }

    override fun visitClass(aClass: PsiClass) {
        if (topLevelName == null) {
            // Capture the first (top-level) class
            topLevelKind = when {
                aClass.isInterface -> "interface"
                aClass.isEnum -> "enum"
                aClass.isRecord -> "record"
                aClass.isAnnotationType -> "annotation"
                else -> "class"
            }
            topLevelName = aClass.qualifiedName ?: aClass.name
            topLevelSignature = buildClassSignature(aClass)
        }
        super.visitClass(aClass)
    }

    private fun buildClassSignature(aClass: PsiClass): String {
        val sb = StringBuilder()
        sb.append(aClass.modifierList?.text?.trim() ?: "public")
        sb.append(" class ").append(aClass.name)

        // Super class
        aClass.superClass?.let { sup ->
            sb.append(" extends ").append(sup.name)
        }

        // Interfaces
        val interfaces = aClass.implementsList?.referenceElements
        if (!interfaces.isNullOrEmpty()) {
            sb.append(" implements ")
            sb.append(interfaces.joinToString(", ") { it.referenceName })
        }

        // Method signatures
        val methods = aClass.methods.take(10) // Limit to first 10 methods
        if (methods.isNotEmpty()) {
            sb.append(" { ")
            methods.forEach { method ->
                sb.append(buildMethodSignature(method)).append("; ")
            }
            if (aClass.methods.size > 10) {
                sb.append("... +${aClass.methods.size - 10} more ")
            }
            sb.append("}")
        }

        return sb.toString()
    }

    private fun buildMethodSignature(method: PsiMethod): String {
        val sb = StringBuilder()
        sb.append(method.modifierList?.text?.trim() ?: "")
        sb.append(" ").append(method.returnType?.presentableText ?: "void")
        sb.append(" ").append(method.name)
        sb.append("(")
        sb.append(method.parameterList.parameters.joinToString(", ") { param ->
            "${param.type.presentableText} ${param.name}"
        })
        sb.append(")")
        return sb.toString().replace("\\s+".toRegex(), " ").trim()
    }

    override fun visitFile(file: com.intellij.psi.PsiFile) {
        importList.clear()
        super.visitFile(file)
        imports = importList.filter { it.isNotEmpty() }
    }
}