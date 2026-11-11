process.env.NODE_ENV = 'test';
process.env.PORT = '4005';
process.env.INTERNAL_SERVICE_SECRET = 'test-secret-at-least-32-characters-long!!';
process.env.INTERNAL_SERVICE_ISSUER = 'collegeshub-core';
process.env.INTERNAL_SERVICE_AUDIENCE = 'collegeshub-ai';
process.env.AI_DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.MASTER_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.GEMINI_API_KEY = 'test-gemini-key';

// Mock Redis client for deterministic testing
const mockRedisSet = jest.fn().mockResolvedValue('OK');
const mockRedisGet = jest.fn().mockResolvedValue(null);
const mockRedisConnect = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/infrastructure/redis', () => ({
  getRedisClient: () => ({
    status: 'ready',
    connect: mockRedisConnect,
    set: mockRedisSet,
    get: mockRedisGet,
  }),
}));

import request from 'supertest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import app from '../src/server';
import { TextChunker } from '../src/modules/documents/TextChunker';
import { EmbeddingService } from '../src/modules/embeddings/EmbeddingService';
import { RAGService } from '../src/modules/rag/RAGService';

// Helper to generate valid S2S assertion
function generateAssertion(payloadOverrides: Record<string, any> = {}) {
  const secret = process.env.INTERNAL_SERVICE_SECRET!;
  const payload = {
    sub: 'user-test-123',
    collegeId: 'college-test-456',
    role: 'admin',
    planId: 'premium',
    collegeVersion: 1,
    jti: crypto.randomUUID(),
    ...payloadOverrides,
  };

  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
    issuer: process.env.INTERNAL_SERVICE_ISSUER || 'collegeshub-core',
    audience: process.env.INTERNAL_SERVICE_AUDIENCE || 'collegeshub-ai',
    expiresIn: '60s',
  });
}

describe('Phase 6: Document Intelligence & Academic RAG (pgvector) Tests', () => {
  describe('TextChunker', () => {
    it('chunks text into blocks and preserves page numbers', () => {
      const chunker = new TextChunker(50, 10); // Small token limit for testing
      const pages = [
        { pageNumber: 1, text: 'This is page one introductory concept about biology and cells.' },
        { pageNumber: 2, text: 'This is page two discussing photosynthesis and plant metabolism in detail.' },
      ];

      const chunks = chunker.chunkPages(pages);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0].pageNumber).toBe(1);
      expect(chunks[0].chunkIndex).toBe(0);
      expect(chunks[chunks.length - 1].pageNumber).toBe(2);
      expect(chunks[0].tokenCount).toBeGreaterThan(0);
    });

    it('splits long paragraphs into overlapping sub-chunks', () => {
      const chunker = new TextChunker(20, 5);
      const longText = 'Word '.repeat(100);
      const pages = [{ pageNumber: 1, text: longText }];

      const chunks = chunker.chunkPages(pages);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].pageNumber).toBe(1);
      expect(chunks[1].pageNumber).toBe(1);
    });
  });

  describe('EmbeddingService', () => {
    it('throws error when attempting to embed empty text', async () => {
      const service = new EmbeddingService();
      await expect(service.embedQuery('')).rejects.toThrow('Cannot generate embedding for empty text');
    });

    it('returns empty array when batch embedding an empty array', async () => {
      const service = new EmbeddingService();
      const res = await service.batchEmbed([]);
      expect(res).toEqual([]);
    });
  });

  describe('RAGService', () => {
    let mockPrisma: any;
    let mockEmbeddingService: any;
    let ragService: RAGService;

    beforeEach(() => {
      mockPrisma = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: 'chunk-1',
            documentId: 'doc-1',
            collegeId: 'college-test-456',
            chunkIndex: 0,
            text: 'Mitochondria is the powerhouse of the cell.',
            tokenCount: 45,
            pageNumber: 12,
            documentTitle: 'Campbell Biology 12th Ed',
            documentSubject: 'Biology',
            similarity: 0.892,
          },
        ]),
        documentChunk: {
          create: jest.fn().mockResolvedValue({ id: 'chunk-1' }),
        },
      };

      mockEmbeddingService = {
        embedQuery: jest.fn().mockResolvedValue(new Array(768).fill(0.1)),
      };

      ragService = new RAGService(mockPrisma, mockEmbeddingService);
    });

    it('indexes chunks into pgvector via raw SQL execution', async () => {
      const chunks = [
        {
          chunkIndex: 0,
          text: 'Mitochondria is the powerhouse of the cell.',
          tokenCount: 45,
          pageNumber: 12,
          embedding: new Array(768).fill(0.05),
        },
      ];

      const indexed = await ragService.indexChunks('doc-1', 'college-test-456', chunks);
      expect(indexed).toBe(1);
      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    });

    it('searches chunks using cosine distance and returns citations', async () => {
      const results = await ragService.searchChunks({
        collegeId: 'college-test-456',
        query: 'What is mitochondria?',
        subject: 'Biology',
        topK: 5,
        minSimilarity: 0.35,
      });

      expect(results.length).toBe(1);
      expect(results[0].documentTitle).toBe('Campbell Biology 12th Ed');
      expect(results[0].pageNumber).toBe(12);
      expect(results[0].citation).toBe('[Campbell Biology 12th Ed | Page 12]');
      expect(results[0].similarity).toBe(0.892);
    });
  });

  describe('RAG HTTP Endpoints Integration', () => {
    it('rejects unauthenticated RAG query requests', async () => {
      const res = await request(app)
        .post('/internal/v1/rag/query')
        .send({ query: 'cell division' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('MISSING_SERVICE_ASSERTION');
    });

    it('rejects RAG query requests with empty query', async () => {
      const token = generateAssertion();
      const res = await request(app)
        .post('/internal/v1/rag/query')
        .set('x-collegeshub-assertion', token)
        .send({ query: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_QUERY');
    });
  });
});

