// SPDX-License-Identifier: AGPL-3.0-only WITH non-commercial-clause
import { useState } from "react";
import type { ReactElement } from "react";
import { Box, Text, useApp, useInput } from "ink";

// Multi-select for `plumbline mcp install`. Mirrors RepoSelector's multi-mode
// (space-toggle, enter-submit, esc-cancel) but defaults every row to selected
// — the common case is "configure all detected tools" and the user deselects
// the ones they don't want. `a` toggles all/none.

export interface McpToolSelectorItem {
  id: string;
  /** Tool name, e.g. "Cursor". */
  label: string;
  /** Dim secondary text — the config path that would be written. */
  detail: string;
}

export interface McpToolSelectorResult {
  picked?: McpToolSelectorItem[];
  cancelled?: boolean;
}

export interface McpToolSelectorProps {
  items: McpToolSelectorItem[];
  onDone: (result: McpToolSelectorResult) => void;
}

export function McpToolSelector({ items, onDone }: McpToolSelectorProps): ReactElement {
  const { exit } = useApp();
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set(items.map((_, i) => i)));

  const resolvePicked = (): McpToolSelectorItem[] => {
    return [...selected]
      .sort((a, b) => a - b)
      .map((i) => items[i])
      .filter((x): x is McpToolSelectorItem => x !== undefined);
  };

  useInput((input, key) => {
    if (key.escape) {
      exit();
      onDone({ cancelled: true });
      return;
    }
    if (key.upArrow || input === "k") {
      setIndex((i) => (i > 0 ? i - 1 : items.length - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setIndex((i) => (i < items.length - 1 ? i + 1 : 0));
      return;
    }
    if (input === " ") {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(index)) {
          next.delete(index);
        } else {
          next.add(index);
        }
        return next;
      });
      return;
    }
    if (input === "a") {
      setSelected((prev) => (prev.size === items.length ? new Set<number>() : new Set(items.map((_, i) => i))));
      return;
    }
    if (key.return) {
      const picked = resolvePicked();
      exit();
      onDone(picked.length === 0 ? { cancelled: true } : { picked });
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} paddingY={0}>
      <Box marginBottom={1}>
        <Text bold>
          Register plumbline MCP in:
          <Text dimColor>{`  (${selected.size} selected)`}</Text>
        </Text>
      </Box>
      {items.map((item, i) => (
        <Box key={item.id}>
          <Text color={i === index ? "cyan" : "gray"}>{i === index ? "▶ " : "  "}</Text>
          <Text>{selected.has(i) ? "[x] " : "[ ] "}</Text>
          <Text color={i === index ? "cyan" : "gray"}>{item.label}</Text>
          <Text dimColor> {item.detail}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>[↑/↓ or j/k] move [Space] toggle [a] all/none [Enter] confirm [Esc] cancel</Text>
      </Box>
    </Box>
  );
}
