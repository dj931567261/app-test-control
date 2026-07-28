/** Candidate samples returned in a bounded ambiguity response. */
export const MAX_AMBIGUITY_ELEMENTS = 20;

/** Explicit selection may only reference a candidate the caller could see. */
export const MAX_EXPLICIT_CANDIDATE_INDEX = MAX_AMBIGUITY_ELEMENTS - 1;

/** Raw uiautomator XML accepted before parsing. */
export const MAX_HIERARCHY_XML_BYTES = 3 * 1024 * 1024;

/** Internal parse budget; larger trees fail closed instead of exhausting memory. */
export const MAX_HIERARCHY_ELEMENTS = 5_000;
export const MAX_HIERARCHY_DEPTH = 256;

/** MCP-facing hierarchy samples remain useful without serializing the whole tree. */
export const MAX_HIERARCHY_OUTPUT_ELEMENTS = 256;
export const MAX_FIND_ELEMENTS_OUTPUT = 256;
export const MAX_FINGERPRINT_OUTPUT_SIGNALS = 256;
export const MAX_ELEMENT_OUTPUT_FIELD_BYTES = 512;

/** Final defense-in-depth budget for any one UI MCP text response. */
export const MAX_UI_RESPONSE_BYTES = 4 * 1024 * 1024;
