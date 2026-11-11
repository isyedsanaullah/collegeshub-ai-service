export interface PageText {
  pageNumber: number;
  text: string;
}

export interface ChunkOutput {
  chunkIndex: number;
  text: string;
  tokenCount: number;
  pageNumber: number;
}

export class TextChunker {
  private readonly targetChunkChars: number;
  private readonly overlapChars: number;

  constructor(targetChunkTokens: number = 500, overlapTokens: number = 50) {
    // 1 token ≈ 4 characters
    this.targetChunkChars = targetChunkTokens * 4;
    this.overlapChars = overlapTokens * 4;
  }

  /**
   * Chunk multi-page text into overlapping chunks, tracking page numbers.
   */
  public chunkPages(pages: PageText[]): ChunkOutput[] {
    const chunks: ChunkOutput[] = [];
    let chunkIndex = 0;

    for (const page of pages) {
      const cleanText = page.text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
      if (!cleanText) continue;

      if (cleanText.length <= this.targetChunkChars) {
        chunks.push({
          chunkIndex: chunkIndex++,
          text: cleanText,
          tokenCount: Math.ceil(cleanText.length / 4),
          pageNumber: page.pageNumber,
        });
        continue;
      }

      // Split into paragraphs first for semantic preservation
      const paragraphs = cleanText.split('\n\n');
      let currentChunkText = '';

      for (const para of paragraphs) {
        const trimmedPara = para.trim();
        if (!trimmedPara) continue;

        if ((currentChunkText + '\n\n' + trimmedPara).length <= this.targetChunkChars) {
          currentChunkText = currentChunkText ? currentChunkText + '\n\n' + trimmedPara : trimmedPara;
        } else {
          if (currentChunkText) {
            chunks.push({
              chunkIndex: chunkIndex++,
              text: currentChunkText,
              tokenCount: Math.ceil(currentChunkText.length / 4),
              pageNumber: page.pageNumber,
            });

            // Retain overlap from end of previous chunk
            const overlapStart = Math.max(0, currentChunkText.length - this.overlapChars);
            currentChunkText = currentChunkText.slice(overlapStart) + '\n\n' + trimmedPara;
          } else {
            // Very long single paragraph exceeding target chunk size — sliding window
            let offset = 0;
            while (offset < trimmedPara.length) {
              const slice = trimmedPara.slice(offset, offset + this.targetChunkChars);
              chunks.push({
                chunkIndex: chunkIndex++,
                text: slice,
                tokenCount: Math.ceil(slice.length / 4),
                pageNumber: page.pageNumber,
              });
              offset += this.targetChunkChars - this.overlapChars;
            }
            currentChunkText = '';
          }
        }
      }

      if (currentChunkText.trim()) {
        chunks.push({
          chunkIndex: chunkIndex++,
          text: currentChunkText.trim(),
          tokenCount: Math.ceil(currentChunkText.trim().length / 4),
          pageNumber: page.pageNumber,
        });
      }
    }

    return chunks;
  }
}
