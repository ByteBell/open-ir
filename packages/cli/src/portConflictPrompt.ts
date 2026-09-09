// SPDX-License-Identifier: AGPL-3.0-only WITH non-commercial-clause
import React from "react";
import { render } from "ink";
import {
  PortConflictSelector,
  type PortConflictResolution,
  type PortConflictSelectorProps,
} from "./PortConflictSelector.tsx";
import {
  findContainerOnPort,
  findHostProcessOnPort,
  type ConflictingContainer,
  type ConflictingHostProcess,
} from "./dockerPortDiagnostics.ts";

export interface PortConflictContext {
  port: number;
  serviceLabel: string;
  container: ConflictingContainer | null;
  hostProcess: ConflictingHostProcess | null;
}

export async function diagnosePortConflict(port: number, serviceLabel: string): Promise<PortConflictContext> {
  const container = await findContainerOnPort(port).catch(() => null);
  const hostProcess = container === null ? await findHostProcessOnPort(port) : null;
  return { port, serviceLabel, container, hostProcess };
}

export async function promptPortConflict(ctx: PortConflictContext): Promise<PortConflictResolution> {
  const props: PortConflictSelectorProps = {
    port: ctx.port,
    serviceLabel: ctx.serviceLabel,
    occupantLabel: describeOccupant(ctx),
    canKill: ctx.container !== null,
    onDone: () => {
      // overridden below
    },
  };
  return new Promise<PortConflictResolution>((resolve) => {
    const app = render(
      React.createElement(PortConflictSelector, {
        ...props,
        onDone: (result) => {
          app.unmount();
          resolve(result);
        },
      }),
    );
  });
}

function describeOccupant(ctx: PortConflictContext): string {
  if (ctx.container !== null) {
    const flag = ctx.container.isPlumbline ? " [plumbline]" : "";
    return `container ${ctx.container.name} (${ctx.container.image})${flag}`;
  }
  if (ctx.hostProcess !== null) {
    return `host process ${ctx.hostProcess.command} (pid ${ctx.hostProcess.pid})`;
  }
  return "unknown process";
}
