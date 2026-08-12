import { CommandRegistry } from "../command-registry.js";
import { aiCommand } from "./ai.js";
import { helpCommand } from "./help.js";
import { pingCommand } from "./ping.js";

export function createBuiltinCommandRegistry({ prefix = "/" } = {}) {
  return new CommandRegistry({ prefix })
    .register(helpCommand)
    .register(pingCommand)
    .register(aiCommand);
}
