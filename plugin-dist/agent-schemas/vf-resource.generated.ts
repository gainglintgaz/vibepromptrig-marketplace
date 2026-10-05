// Generated from agent-schemas/vf-resource.schema.json. Do not edit by hand.
// JSON Schema: https://json-schema.org/draft/2020-12/schema

export interface VFResourceRecord {
  "uri": string;
  "slug": string;
  "version": string;
  "name": string;
  "title": string;
  "description": string;
  "mimeType": "text/markdown";
  "privacyClass": "public" | "factory_internal" | "project_confidential" | "pii_restricted" | "secret_prohibited";
  "sourcePath": string;
  "dependencies": Array<{
    "id": string;
    "sourcePath": string;
    "risk": "W0" | "W1" | "W2" | "W3";
    "loadBearing": true;
  }>;
}
