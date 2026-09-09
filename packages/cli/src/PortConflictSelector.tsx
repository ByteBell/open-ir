// SPDX-License-Identifier: AGPL-3.0-only WITH non-commercial-clause
import { useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";

export type PortConflictAction = "reuse" | "kill" | "change" | "cancel";

export interface PortConflictResolution {
  action: PortConflictAction;
  newPort?: number;
}

export interface PortConflictSelectorProps {
  port: number;
  serviceLabel: string;
  occupantLabel: string;
  canKill: boolean;
  onDone: (result: PortConflictResolution) => void;
}

interface Choice {
  action: Exclude<PortConflictAction, "cancel">;
  label: string;
  hint: string;
  disabled?: boolean;
  disabledHint?: string;
}

export function PortConflictSelector(props: PortConflictSelectorProps): ReactElement {
  const { exit } = useApp();
  const [index, setIndex] = useState(0);
  const [stage, setStage] = useState<"choose" | "port-input">("choose");
  const [portInput, setPortInput] = useState(String(props.port + 1));
  const [error, setError] = useState<string | null>(null);

  const choices: Choice[] = [
    {
      action: "reuse",
      label: `Use the service already running on ${props.port}`,
      hint: "skip starting plumbline's container for this service",
    },
    killChoice(props),
    {
      action: "change",
      label: `Change plumbline's host port for ${props.serviceLabel}`,
      hint: "pick a new free port; plumbline config + compose env are updated",
    },
  ];

  useInput((input, key) => {
    if (stage === "choose") {
      if (key.escape) {
        exit();
        props.onDone({ action: "cancel" });
        return;
      }
      if (key.upArrow || input === "k") {
        setIndex((i) => nextEnabledIndex(choices, i, -1));
        return;
      }
      if (key.downArrow || input === "j") {
        setIndex((i) => nextEnabledIndex(choices, i, 1));
        return;
      }
      if (key.return) {
        const chosen = choices[index];
        if (chosen === undefined || chosen.disabled === true) {
          return;
        }
        if (chosen.action === "change") {
          setStage("port-input");
          return;
        }
        exit();
        props.onDone({ action: chosen.action });
      }
      return;
    }
    if (key.escape) {
      setStage("choose");
      setError(null);
    }
  });

  if (stage === "port-input") {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1} paddingY={0}>
        <Text bold>New host port for {props.serviceLabel}</Text>
        <Text dimColor>current: {props.port} — Enter to confirm, Esc to go back</Text>
        <Box marginTop={1}>
          <Text>Port: </Text>
          <TextInput
            value={portInput}
            onChange={(value) => {
              setPortInput(value);
              if (error !== null) {
                setError(null);
              }
            }}
            onSubmit={(value) => {
              const parsed = parsePort(value, props.port);
              if (typeof parsed === "string") {
                setError(parsed);
                return;
              }
              exit();
              props.onDone({ action: "change", newPort: parsed });
            }}
          />
        </Box>
        {error !== null ? (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} paddingY={0}>
      <Box marginBottom={1} flexDirection="column">
        <Text bold>
          Port {props.port} is already in use ({props.serviceLabel}).
        </Text>
        <Text dimColor>occupant: {props.occupantLabel}</Text>
      </Box>
      {choices.map((choice, i) => {
        const selected = i === index;
        const colorProp = choice.disabled === true ? { color: "gray" } : selected ? { color: "cyan" } : {};
        return (
          <Box key={choice.action} flexDirection="column">
            <Text {...colorProp}>
              {selected ? "❯ " : "  "}
              {choice.label}
            </Text>
            <Text dimColor> {choice.disabled === true ? (choice.disabledHint ?? choice.hint) : choice.hint}</Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ to choose, Enter to confirm, Esc to cancel</Text>
      </Box>
    </Box>
  );
}

function killChoice(props: PortConflictSelectorProps): Choice {
  if (props.canKill) {
    return {
      action: "kill",
      label: `Stop the conflicting container and reuse port ${props.port}`,
      hint: `docker rm -f ${props.occupantLabel}`,
    };
  }
  return {
    action: "kill",
    label: `Stop the conflicting container and reuse port ${props.port}`,
    hint: "no removable container found",
    disabled: true,
    disabledHint: "occupant is not a docker container — stop it manually",
  };
}

function nextEnabledIndex(choices: Choice[], from: number, step: number): number {
  const n = choices.length;
  for (let i = 1; i <= n; i += 1) {
    const candidate = (from + step * i + n) % n;
    if (choices[candidate]?.disabled !== true) {
      return candidate;
    }
  }
  return from;
}

function parsePort(raw: string, current: number): number | string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "Enter a port number.";
  }
  if (!/^\d+$/u.test(trimmed)) {
    return "Port must be a positive integer.";
  }
  const n = Number.parseInt(trimmed, 10);
  if (n < 1 || n > 65535) {
    return "Port must be between 1 and 65535.";
  }
  if (n === current) {
    return "Pick a different port than the conflicting one.";
  }
  return n;
}
