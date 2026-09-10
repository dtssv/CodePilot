/**
 * Structured question dialog (ask_user_question / plan_done).
 *
 * Walks the user through 1–4 questions one at a time:
 *  - questions WITH options    → arrow-key / number-key selector; Space
 *    toggles entries when multiSelect is set; Enter confirms.
 *  - questions WITHOUT options → free-text line input; Enter confirms.
 *
 * When the last question is answered, onDone(answers) fires with a map keyed
 * by question id (option label, list of labels, or free text).
 */
import React from "react";
import { Box, Text, useInput } from "ink";
import type { QuestionAnswers, QuestionRequest, QuestionSpec } from "@codepilot/core";

export interface QuestionPromptProps {
  request: QuestionRequest;
  onDone: (answers: QuestionAnswers) => void;
}

export function QuestionPrompt(props: QuestionPromptProps): React.ReactElement {
  const { request, onDone } = props;
  const [qIdx, setQIdx] = React.useState(0);
  const answersRef = React.useRef<QuestionAnswers>({});

  const question: QuestionSpec | undefined = request.questions[qIdx];

  const advance = React.useCallback(
    (id: string, answer: string | string[]) => {
      answersRef.current = { ...answersRef.current, [id]: answer };
      if (qIdx + 1 >= request.questions.length) {
        onDone(answersRef.current);
      } else {
        setQIdx(qIdx + 1);
      }
    },
    [qIdx, request.questions.length, onDone],
  );

  if (question === undefined) {
    // Shouldn't happen (parent unmounts us on done), but stay safe.
    return <Text dimColor>(no question)</Text>;
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        ? {question.header ?? "Question"}{" "}
        <Text dimColor>
          ({qIdx + 1}/{request.questions.length})
        </Text>
      </Text>
      <Text>{question.question}</Text>
      <Box marginTop={1}>
        {question.options !== undefined && question.options.length > 0 ? (
          <OptionPicker
            key={question.id}
            options={question.options}
            multiSelect={question.multiSelect === true}
            onPick={(answer) => advance(question.id, answer)}
          />
        ) : (
          <FreeTextInput
            key={question.id}
            onSubmit={(text) => advance(question.id, text)}
          />
        )}
      </Box>
    </Box>
  );
}

interface OptionPickerProps {
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  onPick: (answer: string | string[]) => void;
}

function OptionPicker(props: OptionPickerProps): React.ReactElement {
  const { options, multiSelect, onPick } = props;
  const [cursor, setCursor] = React.useState(0);
  const [checked, setChecked] = React.useState<Set<number>>(new Set());

  useInput(
    (input, key) => {
      if (key.upArrow) {
        setCursor((i) => (i - 1 + options.length) % options.length);
        return;
      }
      if (key.downArrow) {
        setCursor((i) => (i + 1) % options.length);
        return;
      }
      // Number keys 1–9 jump directly to an option (single-select picks it,
      // multi-select toggles it).
      const n = Number.parseInt(input, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= options.length && String(n) === input) {
        if (multiSelect) {
          toggle(n - 1);
        } else {
          onPick(options[n - 1]!.label);
        }
        return;
      }
      if (key.return) {
        if (multiSelect) {
          if (checked.size === 0) {
            // Nothing checked → treat Enter as toggling the cursor row so the
            // user can't submit an empty selection by accident.
            toggle(cursor);
            return;
          }
          onPick(
            options
              .map((o, i) => ({ o, i }))
              .filter(({ i }) => checked.has(i))
              .map(({ o }) => o.label),
          );
        } else {
          onPick(options[cursor]!.label);
        }
        return;
      }
      if (input === " " && multiSelect) {
        toggle(cursor);
        return;
      }
    },
    { isActive: true },
  );

  function toggle(i: number): void {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  return (
    <Box flexDirection="column">
      {options.map((opt, i) => {
        const selected = i === cursor;
        const mark = multiSelect ? (checked.has(i) ? "[x] " : "[ ] ") : "";
        return (
          <Text key={opt.label} inverse={selected && !multiSelect}>
            {selected ? "▶ " : "  "}
            {mark}
            {i + 1}. {opt.label}
            {opt.description !== undefined ? (
              <Text dimColor> — {opt.description}</Text>
            ) : null}
          </Text>
        );
      })}
      <Text dimColor>
        {multiSelect
          ? "↑/↓ move · Space toggle · 1-9 toggle · Enter confirm"
          : "↑/↓ select · 1-9 jump · Enter confirm"}
      </Text>
    </Box>
  );
}

interface FreeTextInputProps {
  onSubmit: (text: string) => void;
}

function FreeTextInput(props: FreeTextInputProps): React.ReactElement {
  const { onSubmit } = props;
  const [value, setValue] = React.useState("");

  useInput(
    (input, key) => {
      if (key.return) {
        const text = value.trim();
        if (text.length === 0) return;
        onSubmit(text);
        return;
      }
      if (key.backspace || key.delete) {
        if (value.length > 0) setValue(value.slice(0, -1));
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        setValue(value + input);
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column">
      <Text>
        › {value.length === 0 ? <Text dimColor>(type your answer)</Text> : value}
      </Text>
      <Text dimColor>Enter submit</Text>
    </Box>
  );
}
