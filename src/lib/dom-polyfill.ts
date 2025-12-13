// src/lib/dom-polyfill.ts
// DOM API polyfills for Cloudflare Workers
// The AWS SDK uses DOMParser for XML parsing which doesn't exist in Workers

import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

// Polyfill DOMParser
if (typeof globalThis.DOMParser === 'undefined') {
  (globalThis as any).DOMParser = DOMParser;
}

// Polyfill XMLSerializer
if (typeof globalThis.XMLSerializer === 'undefined') {
  (globalThis as any).XMLSerializer = XMLSerializer;
}

// Node constants polyfill (AWS SDK checks these for XML node types)
if (typeof globalThis.Node === 'undefined') {
  (globalThis as any).Node = {
    ELEMENT_NODE: 1,
    ATTRIBUTE_NODE: 2,
    TEXT_NODE: 3,
    CDATA_SECTION_NODE: 4,
    ENTITY_REFERENCE_NODE: 5,
    ENTITY_NODE: 6,
    PROCESSING_INSTRUCTION_NODE: 7,
    COMMENT_NODE: 8,
    DOCUMENT_NODE: 9,
    DOCUMENT_TYPE_NODE: 10,
    DOCUMENT_FRAGMENT_NODE: 11,
    NOTATION_NODE: 12,
  };
}

export {};
