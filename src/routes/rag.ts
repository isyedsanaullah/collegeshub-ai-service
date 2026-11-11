import { Router, Request, Response } from 'express';
import pino from 'pino';
import { verifyServiceAssertion } from '../security/verifyServiceAssertion';
import { RAGService } from '../modules/rag/RAGService';
import { PDFIndexingWorker } from '../workers/pdfIndexingWorker';
import { getEnv } from '../config/env';

const router = Router();
const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });

const ragService = new RAGService();
const pdfIndexingWorker = new PDFIndexingWorker();

/**
 * POST /internal/v1/rag/query
 * Tenant-isolated semantic search using pgvector cosine distance.
 */
router.post('/query', verifyServiceAssertion, async (req: Request, res: Response): Promise<void> => {
  const tenantContext = req.tenantContext!;
  const { query, subject, topK = 5, minSimilarity = 0.35 } = req.body;

  if (!query || typeof query !== 'string' || !query.trim()) {
    res.status(400).json({
      success: false,
      error: 'INVALID_QUERY',
      message: 'query parameter is required and must not be empty',
    });
    return;
  }

  try {
    const chunks = await ragService.searchChunks({
      collegeId: tenantContext.collegeId,
      query: query.trim(),
      subject,
      topK: Math.min(20, Math.max(1, Number(topK) || 5)),
      minSimilarity: Number(minSimilarity) || 0.35,
    });

    res.status(200).json({
      success: true,
      collegeId: tenantContext.collegeId,
      chunks,
      count: chunks.length,
    });
  } catch (err: any) {
    logger.error({ err: err.message, collegeId: tenantContext.collegeId }, 'RAG query failed');
    res.status(500).json({
      success: false,
      error: 'RAG_QUERY_FAILED',
      message: err.message,
    });
  }
});

/**
 * POST /internal/v1/rag/index
 * Ingest and index a document into pgvector.
 */
router.post('/index', verifyServiceAssertion, async (req: Request, res: Response): Promise<void> => {
  const tenantContext = req.tenantContext!;
  const { documentId, title, subject, fileBase64 } = req.body;

  if (!documentId || !title || !fileBase64) {
    res.status(400).json({
      success: false,
      error: 'MISSING_PARAMETERS',
      message: 'documentId, title, and fileBase64 are required',
    });
    return;
  }

  try {
    const fileBuffer = Buffer.from(fileBase64, 'base64');
    const result = await pdfIndexingWorker.processDocument({
      documentId,
      collegeId: tenantContext.collegeId,
      fileBuffer,
      title,
      subject,
    });

    res.status(200).json({
      success: true,
      documentId,
      chunkCount: result.chunkCount,
      pageCount: result.pageCount,
    });
  } catch (err: any) {
    logger.error({ err: err.message, documentId }, 'Document indexing endpoint failed');
    res.status(500).json({
      success: false,
      error: 'INDEXING_FAILED',
      message: err.message,
    });
  }
});

export default router;
