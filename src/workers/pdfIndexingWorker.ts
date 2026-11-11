import pdfParse from 'pdf-parse';
import pino from 'pino';
import { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../infrastructure/database';
import { getEnv } from '../config/env';
import { TextChunker, PageText } from '../modules/documents/TextChunker';
import { EmbeddingService } from '../modules/embeddings/EmbeddingService';
import { RAGService, ChunkWithEmbedding } from '../modules/rag/RAGService';

const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });

export interface IndexingJobPayload {
  documentId: string;
  collegeId: string;
  fileBuffer: Buffer;
  title: string;
  subject?: string;
}

export class PDFIndexingWorker {
  private prisma: PrismaClient;
  private chunker: TextChunker;
  private embeddingService: EmbeddingService;
  private ragService: RAGService;

  constructor(prismaClient?: PrismaClient) {
    this.prisma = prismaClient || getPrismaClient();
    this.chunker = new TextChunker(500, 50);
    this.embeddingService = new EmbeddingService();
    this.ragService = new RAGService(this.prisma, this.embeddingService);
  }

  /**
   * Process and index a PDF file into chunks and vector embeddings.
   */
  public async processDocument(payload: IndexingJobPayload): Promise<{ chunkCount: number; pageCount: number }> {
    const { documentId, collegeId, fileBuffer, title } = payload;
    logger.info({ documentId, collegeId, title }, 'Beginning PDF extraction and indexing');

    // 1. Mark status as PROCESSING
    await this.prisma.documentKnowledgeBase.update({
      where: { id: documentId },
      data: { status: 'PROCESSING', errorMessage: null },
    }).catch(() => {});

    try {
      // 2. Parse PDF buffer with page-level render callback
      const pages: PageText[] = [];
      let currentPageNumber = 1;

      const pdfData = await pdfParse(fileBuffer, {
        pagerender: (pageData: any) => {
          return pageData.getTextContent().then((textContent: any) => {
            const pageText = textContent.items.map((item: any) => item.str).join(' ');
            pages.push({
              pageNumber: currentPageNumber++,
              text: pageText,
            });
            return pageText;
          });
        },
      });

      const totalPages = pdfData.numpages || pages.length || 1;

      // 3. Chunk text blocks with page citations
      const chunks = this.chunker.chunkPages(pages);
      logger.info({ documentId, totalPages, chunkCount: chunks.length }, 'PDF chunked successfully');

      if (chunks.length === 0) {
        throw new Error('PDF document contains no extractable text');
      }

      // 4. Generate batch embeddings
      const textsToEmbed = chunks.map((c) => c.text);
      const embeddings = await this.embeddingService.batchEmbed(textsToEmbed);

      const chunksWithEmbeddings: ChunkWithEmbedding[] = chunks.map((c, idx) => ({
        ...c,
        embedding: embeddings[idx] || new Array(768).fill(0),
      }));

      // 5. Index into PostgreSQL pgvector
      const indexed = await this.ragService.indexChunks(documentId, collegeId, chunksWithEmbeddings);

      // 6. Update document state to INDEXED
      await this.prisma.documentKnowledgeBase.update({
        where: { id: documentId },
        data: {
          status: 'INDEXED',
          pageCount: totalPages,
          errorMessage: null,
        },
      });

      logger.info({ documentId, indexedChunks: indexed, totalPages }, 'Document indexed into pgvector successfully');
      return { chunkCount: indexed, pageCount: totalPages };
    } catch (err: any) {
      logger.error({ documentId, err: err.message }, 'PDF indexing worker failed');

      await this.prisma.documentKnowledgeBase.update({
        where: { id: documentId },
        data: {
          status: 'FAILED',
          errorMessage: err.message,
        },
      }).catch(() => {});

      throw err;
    }
  }
}
