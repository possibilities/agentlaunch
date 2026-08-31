import { COMMANDS, META } from "./contract.ts";
import { renderAgentHelp, renderAgentTeaser, renderCommandHelp, renderTopHelp } from "./render.ts";

export const VERSION = `${META.name} ${META.version}`;

/** All rendered from src/contract.ts — never authored here. Adding a command
 * or argument means editing contract.ts; these are its renders, not a second
 * authorship of the same facts. */
export const TOP_HELP = renderTopHelp();

export const HELP: Record<string, string> = Object.fromEntries(
  COMMANDS.filter((command) => command.subcommands === undefined).map((command) => [
    command.name,
    renderCommandHelp([command.name]),
  ]),
);

export const AGENT_TEASER = renderAgentTeaser();

export const AGENT_HELP = renderAgentHelp();
