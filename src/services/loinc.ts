import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { FastifyError } from 'fastify'
// Import from local package
import { searchLOINC, getLOINCByCode } from '../../../loinc/dist'

export default (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
  next: (err?: FastifyError) => void,
) => {
  // GET /loinc/search?q=glucose&limit=50 - Search LOINC codes
  fastify.get('/loinc/search', async (request, reply) => {
    try {
      const { q, limit = 50 } = request.query as { q?: string; limit?: number }

      if (!q || q.trim().length === 0) {
        reply.code(400).send({ error: 'Query parameter "q" is required' })
        return
      }

      const results = searchLOINC(q, parseInt(String(limit), 10))
      fastify.log.info({ query: q, count: results.length }, 'loinc.search')
      reply.send({ codes: results, count: results.length })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'loinc.search_failed')
      reply.code(500).send({ error: 'Failed to search LOINC codes' })
    }
  })

  // GET /loinc/:code - Get LOINC code by coding value
  fastify.get('/loinc/:code', async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const loincCode = getLOINCByCode(code)

      if (!loincCode) {
        reply.code(404).send({ error: `LOINC code "${code}" not found` })
        return
      }

      fastify.log.info({ code }, 'loinc.get')
      reply.send(loincCode)
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'loinc.get_failed')
      reply.code(500).send({ error: 'Failed to get LOINC code' })
    }
  })

  next()
}

