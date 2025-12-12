// src/pages/api/newsletter/extract-text.ts
// Extract text content from uploaded PDF or DOCX files for newsletter
import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    
    if (!file) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'No file uploaded' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const filename = file.name.toLowerCase();
    const ext = filename.split('.').pop();
    
    if (!['pdf', 'docx', 'txt'].includes(ext || '')) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Unsupported file type. Please upload .txt, .pdf, or .docx' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    let text = '';
    
    if (ext === 'txt') {
      // Plain text - just read it
      text = await file.text();
    } else if (ext === 'pdf') {
      // For PDF, we'll do basic extraction
      // In production, you'd use a library like pdf-parse
      const buffer = await file.arrayBuffer();
      text = extractTextFromPDF(new Uint8Array(buffer));
    } else if (ext === 'docx') {
      // For DOCX, extract from XML content
      const buffer = await file.arrayBuffer();
      text = await extractTextFromDOCX(new Uint8Array(buffer));
    }
    
    if (!text.trim()) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Could not extract text from file. Try copy-pasting content manually.' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({ 
      success: true, 
      text: text.trim(),
      filename: file.name
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('[extract-text] Error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Failed to process file. Try copy-pasting content manually.',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// Basic PDF text extraction (searches for text streams)
function extractTextFromPDF(data: Uint8Array): string {
  const text: string[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const content = decoder.decode(data);
  
  // Look for text in PDF streams (basic extraction)
  // This is a simplified approach - for production use pdf-parse library
  
  // Try to find text between BT and ET markers (text objects)
  const textObjectRegex = /BT[\s\S]*?ET/g;
  const matches = content.match(textObjectRegex);
  
  if (matches) {
    for (const match of matches) {
      // Extract text from Tj and TJ operators
      const tjMatches = match.match(/\(([^)]*)\)\s*Tj/g);
      if (tjMatches) {
        for (const tj of tjMatches) {
          const textMatch = tj.match(/\(([^)]*)\)/);
          if (textMatch) {
            text.push(decodeEscapedString(textMatch[1]));
          }
        }
      }
    }
  }
  
  // If no text found with BT/ET, try to find readable strings
  if (text.length === 0) {
    // Look for sequences of printable characters
    const readableRegex = /[\x20-\x7E]{10,}/g;
    const readable = content.match(readableRegex);
    if (readable) {
      // Filter out PDF commands and binary-looking content
      const filtered = readable.filter(s => 
        !s.includes('obj') && 
        !s.includes('endobj') && 
        !s.includes('stream') &&
        !s.includes('/Type') &&
        !s.includes('/Filter') &&
        !/^[0-9\s]+$/.test(s)
      );
      text.push(...filtered);
    }
  }
  
  return text.join('\n').replace(/\s+/g, ' ').trim();
}

// Decode PDF escaped strings
function decodeEscapedString(str: string): string {
  return str
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

// Extract text from DOCX (ZIP containing XML)
async function extractTextFromDOCX(data: Uint8Array): Promise<string> {
  try {
    // DOCX is a ZIP file - we need to find document.xml
    // Look for the PK signature and find the document.xml content
    
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const content = decoder.decode(data);
    
    // Find XML content within the DOCX
    // The main document text is in word/document.xml
    const text: string[] = [];
    
    // Look for <w:t> tags which contain text in DOCX
    const textRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    let match;
    
    while ((match = textRegex.exec(content)) !== null) {
      if (match[1]) {
        text.push(match[1]);
      }
    }
    
    // Also try to find plain text content
    if (text.length === 0) {
      // Look for readable text sequences
      const readableRegex = /[\x20-\x7E\u00A0-\u024F]{20,}/g;
      const readable = content.match(readableRegex);
      if (readable) {
        const filtered = readable.filter(s => 
          !s.includes('<?xml') && 
          !s.includes('xmlns') &&
          !s.includes('w:') &&
          !s.includes('PK')
        );
        text.push(...filtered);
      }
    }
    
    // Join and clean up
    let result = text.join(' ');
    
    // Decode XML entities
    result = result
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num)))
      .replace(/\s+/g, ' ')
      .trim();
    
    return result;
    
  } catch (error) {
    console.error('[extractTextFromDOCX] Error:', error);
    return '';
  }
}
