import { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from 'fastify'
import proxy from '@fastify/http-proxy'

interface Options {
  url: string
}

export function couchDBProxy(
  fastify: FastifyInstance,
  options: Options,
  next: (err?: FastifyError | undefined) => void,
) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001'
  const allowedOrigins = [frontendUrl, 'http://localhost:3001', 'http://127.0.0.1:3001']
  
  // Handle preflight OPTIONS requests
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith('/_db') && request.method === 'OPTIONS') {
      const origin = request.headers.origin as string | undefined
      if (origin && allowedOrigins.includes(origin)) {
        reply.header('Access-Control-Allow-Origin', origin)
        reply.header('Access-Control-Allow-Credentials', 'true')
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')
        reply.code(204).send()
        return
      }
    }
  })
  
  // Register proxy
  fastify.register(proxy, {
    upstream: options.url,
    prefix: '/_db',
    rewritePrefix: '/_db',
  })
  
  // Override CORS headers AFTER proxy response
  // onSend hook runs after proxy processes response but before sending to client
  fastify.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: any) => {
    if (request.url.startsWith('/_db')) {
      const origin = request.headers.origin as string | undefined
      if (origin && allowedOrigins.includes(origin)) {
        // Get current headers
        const currentHeaders = reply.getHeaders()
        
        // Remove CouchDB's wildcard CORS headers (case-insensitive)
        Object.keys(currentHeaders).forEach((key) => {
          const lowerKey = key.toLowerCase()
          if (
            lowerKey === 'access-control-allow-origin' ||
            lowerKey === 'access-control-allow-credentials' ||
            lowerKey === 'access-control-allow-methods' ||
            lowerKey === 'access-control-allow-headers'
          ) {
            reply.removeHeader(key)
          }
        })
        
        // Set our CORS headers with specific origin
        reply.header('Access-Control-Allow-Origin', origin)
        reply.header('Access-Control-Allow-Credentials', 'true')
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')
      }
    }
    return payload
  })
  
  next()
}
