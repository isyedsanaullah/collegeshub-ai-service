import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { getPrismaClient } from '../../infrastructure/database';
import { getEnv } from '../../config/env';
import { EmbeddingService } from '../embeddings/EmbeddingService';
import { ChunkOutput } from '../documents/TextChunker';

const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });

export interface RetrievedChunk {
  id: string;
  documentId: string;
  documentTitle: string;
  subject?: string;
  text: string;
  pageNumber?: number;
  similarity: number;
  citation: string;
}

export interface ChunkWithEmbedding extends ChunkOutput {
  embedding: number[];
}

export class RAGService {
  private prisma: PrismaClient;
  private embeddingService: EmbeddingService;

  constructor(prismaClient?: PrismaClient, embeddingService?: EmbeddingService) {
    this.prisma = prismaClient || getPrismaClient();
    this.embeddingService = embeddingService || new EmbeddingService();
  }

  /**
   * Index chunks with vector embeddings into PostgreSQL pgvector table.
   */
  public async indexChunks(
    documentId: string,
    collegeId: string,
    chunks: ChunkWithEmbedding[]
  ): Promise<number> {
    if (!chunks.length) return 0;

    let indexedCount = 0;

    for (const chunk of chunks) {
      const vectorLiteral = `[${chunk.embedding.join(',')}]`;

      try {
        await this.prisma.$executeRaw`
          INSERT INTO "DocumentChunk" (
            "id", "documentId", "collegeId", "chunkIndex", "text", "tokenCount", "pageNumber", "embedding", "createdAt"
          ) VALUES (
            gen_random_uuid(), ${documentId}, ${collegeId}, ${chunk.chunkIndex}, ${chunk.text}, ${chunk.tokenCount}, ${chunk.pageNumber}, ${vectorLiteral}::vector, NOW()
          )
        `;
        indexedCount++;
      } catch (err: any) {
        // Fallback if vector column is mocked or standard Prisma fallback
        try {
          await this.prisma.documentChunk.create({
            data: {
              documentId,
              collegeId,
              chunkIndex: chunk.chunkIndex,
              text: chunk.text,
              tokenCount: chunk.tokenCount,
              pageNumber: chunk.pageNumber,
            },
          });
          indexedCount++;
        } catch (fallbackErr: any) {
          logger.error({ err: fallbackErr.message, chunkIndex: chunk.chunkIndex }, 'Failed to insert document chunk');
        }
      }
    }

    logger.info({ documentId, indexedCount, total: chunks.length }, 'Indexed document chunks into vector store');
    return indexedCount;
  }

  /**
   * Search for nearest-neighbor document chunks using cosine distance.
   * Cosine distance: <=> operator. Similarity = 1 - distance.
   */
  public async searchChunks(params: {
    collegeId: string;
    query: string;
    subject?: string;
    topK?: number;
    minSimilarity?: number;
  }): Promise<RetrievedChunk[]> {
    const { collegeId, query, subject, topK = 5, minSimilarity = 0.35 } = params;

    // 1. Generate query embedding vector
    const queryVector = await this.embeddingService.embedQuery(query);
    const vectorLiteral = `[${queryVector.join(',')}]`;

    // 2. Perform Cosine Similarity Search
    try {
      const results: any[] = await this.prisma.$queryRaw`
        SELECT 
          c."id", 
          c."documentId", 
          c."collegeId", 
          c."chunkIndex", 
          c."text", 
          c."tokenCount", 
          c."pageNumber",
          d."title" AS "documentTitle",
          d."subject" AS "documentSubject",
          (1 - (c."embedding" <=> ${vectorLiteral}::vector)) AS "similarity"
        FROM "DocumentChunk" c
        JOIN "DocumentKnowledgeBase" d ON c."documentId" = d."id"
        WHERE c."collegeId" = ${collegeId}
          AND (${subject}::text IS NULL OR d."subject" = ${subject}::text)
          AND (1 - (c."embedding" <=> ${vectorLiteral}::vector)) >= ${minSimilarity}
        ORDER BY c."embedding" <=> ${vectorLiteral}::vector ASC
        LIMIT ${topK}
      `;

      return results.map((r) => {
        const sim = Number(r.similarity || 0);
        const pageStr = r.pageNumber ? `Page ${r.pageNumber}` : 'General';
        const docTitle = r.documentTitle || 'Course Material';

        return {
          id: r.id,
          documentId: r.documentId,
          documentTitle: docTitle,
          subject: r.documentSubject,
          text: r.text,
          pageNumber: r.pageNumber,
          similarity: Math.round(sim * 1000) / 1000,
          citation: `[${docTitle} | ${pageStr}]`,
        };
      });
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Vector query execution failed; returning empty results');
      return [];
    }
  }
}
