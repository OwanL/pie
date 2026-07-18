import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EMPTY = { type: "object", properties: {}, additionalProperties: false } as const;

const VALUES: Record<string, string> = {
  artifact_metadata_lookup: "artifact=A-17 checksum=cobalt-731",
  release_channel_status: "channel=stable generation=44",
  schema_registry_lookup: "schema=telemetry-v3 revision=12",
  package_provenance_lookup: "package=orion source=internal verified=true",
  deployment_window_lookup: "window=2026-07-19T02:00Z duration=45m",
  feature_flag_snapshot: "flag=stream-cache state=enabled cohort=beta",
  incident_reference_lookup: "incident=INC-204 state=resolved",
  compatibility_matrix_lookup: "runtime=node24 protocol=v3 compatible=true",
};

export default function catalogExtension(pi: ExtensionAPI) {
  for (const [name, value] of Object.entries(VALUES)) {
    pi.registerTool({
      name,
      label: name.replaceAll("_", " "),
      description: `Retrieve authoritative ${name.replaceAll("_", " ")} data for a supplied identifier.`,
      parameters: EMPTY,
      async execute() {
        return { content: [{ type: "text" as const, text: value }] };
      },
    });
  }
}
