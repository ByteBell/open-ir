// SPDX-License-Identifier: AGPL-3.0-only WITH non-commercial-clause
import { useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useApp, useInput } from "ink";

export interface StopInfraPromptProps {
  onDone: (stop: boolean) => void;
}

interface Choice {
  value: boolean;
  label: string;
}

const CHOICES: readonly Choice[] = [
  { value: true, label: "Yes — stop Docker too" },
  { value: false, label: "No — keep it running (warm re-boots)" },
];

export function StopInfraPrompt(props: StopInfraPromptProps): ReactElement {
  const { exit } = useApp();
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    if (input === "y" || input === "Y") {
      exit();
      props.onDone(true);
      return;
    }
    if (input === "n" || input === "N" || key.escape) {
      exit();
      props.onDone(false);
      return;
    }
    if (key.upArrow || key.downArrow || input === "j" || input === "k") {
      setIndex((i) => (i === 0 ? 1 : 0));
      return;
    }
    if (key.return) {
      const chosen = CHOICES[index];
      exit();
      props.onDone(chosen?.value ?? true);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} paddingY={0}>
      <Text bold>Also stop Docker infra (neo4j)?</Text>
      {CHOICES.map((choice, i) => {
        const selected = i === index;
        return (
          <Text key={choice.label} {...(selected ? { color: "cyan" } : {})}>
            {selected ? "❯ " : "  "}
            {choice.label}
          </Text>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ or y/n, Enter to confirm, Esc = no</Text>
      </Box>
    </Box>
  );
}
