import { join } from 'path'
import AutoLoad from '@fastify/autoload'
import { FastifyInstance } from 'fastify'
import helmet from '@fastify/helmet'
import qs from 'qs'
import cors from '@fastify/cors'

async function LaHIM(fastify: FastifyInstance, opts: any) {
  // CORS configuration - must specify origin when credentials are used
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001'
  const allowedOrigins = [
    frontendUrl,
    'http://localhost:3001',
    'http://127.0.0.1:3001',
    // Add production URLs here when deploying
  ]

  fastify.register(cors, {
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Postman, etc.)
      if (!origin) {
        return callback(null, true)
      }
      // Check if origin is in allowed list
      if (allowedOrigins.includes(origin)) {
        callback(null, true)
      } else {
        callback(new Error('Not allowed by CORS'), false)
      }
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Service-Token', 'X-Access-Token'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
  
  // Ensure CORS headers are added even for 404 responses
  fastify.addHook('onSend', async (request, reply, payload) => {
    const origin = request.headers.origin as string | undefined
    if (origin && allowedOrigins.includes(origin)) {
      // Ensure CORS headers are present even for error responses
      if (!reply.getHeader('Access-Control-Allow-Origin')) {
        reply.header('Access-Control-Allow-Origin', origin)
        reply.header('Access-Control-Allow-Credentials', 'true')
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
        reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')
      }
    }
    return payload
  })
  
  fastify.register(helmet)

  // Initialize event bus
  const { eventBus } = require('./lib/event-bus')
  eventBus.initialize(fastify)

  // Initialize event handlers
  const { initializeEventHandlers } = require('./services/event-handlers')
  initializeEventHandlers(fastify)

  // Initialize maintenance scheduler
  const { initializeMaintenanceScheduler } = require('./lib/schedulers/maintenance-scheduler')
  initializeMaintenanceScheduler(fastify)

  // This loads all application wide plugins defined in plugins folder
  fastify.register(AutoLoad, {
    dir: join(__dirname, 'plugins'),
    options: { ...opts },
  } as any)

  // This loads all routes and services defined in services folder
  // Exclude utility files and old service files
  fastify.register(AutoLoad, {
    dir: join(__dirname, 'services'),
    options: { ...opts },
    ignorePattern: /^(dual-write-service|event-handlers|lab-orders-modern|drug-interactions-external)\.(js|ts)$/,
  } as any)
}

LaHIM.options = {
  querystringParser: (str: string) => qs.parse(str),
  logger: true,
  ignoreTrailingSlash: true,
}

export = LaHIM
