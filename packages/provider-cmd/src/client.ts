import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { CommandCodeSettings } from "./settings.ts";

const COMMAND_CODE_PROVIDER = ProviderDriverKind.make("commandCode");

export const commandCodeClient = defineProviderClient({
  driverKind: COMMAND_CODE_PROVIDER,
  label: "Command Code",
  badgeLabel: "cmd",
  settingsSchema: CommandCodeSettings,
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#0F0F0F", dark: "#F5F5F5" },
    paths: [
      {
        // Terminal prompt chevron.
        d: "M4.75 6.6a1.25 1.25 0 0 1 1.77 0l5.3 5.3a1.6 1.6 0 0 1 0 2.2l-5.3 5.3a1.25 1.25 0 1 1-1.77-1.77l4.61-4.53-4.61-4.73a1.25 1.25 0 0 1 0-1.77z",
      },
      {
        // Cursor block.
        d: "M13.5 17.25h6a1.25 1.25 0 0 1 0 2.5h-6a1.25 1.25 0 0 1 0-2.5z",
      },
    ],
  },
});
