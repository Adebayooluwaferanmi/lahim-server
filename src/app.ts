import { join } from 'path'
import AutoLoad from '@fastify/autoload'
import { FastifyInstance, FastifyError } from 'fastify'
import helmet from '@fastify/helmet'
import qs from 'qs'
import cors from '@fastify/cors'

function HospitalRun(fastify: FastifyInstance, opts: any, next: (err?: FastifyError) => void) {
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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
  fastify.register(helmet)

  // Initialize event bus
  const { eventBus } = require('./lib/event-bus')
  eventBus.initialize(fastify)

  // Initialize event handlers
  const { initializeEventHandlers } = require('./services/event-handlers')
  initializeEventHandlers(fastify)

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
    ignorePattern: /^(dual-write-service|event-handlers|lab-orders)\.(js|ts)$/,
  } as any)

  next()
}

HospitalRun.options = {
  querystringParser: (str: string) => qs.parse(str),
  logger: true,
  ignoreTrailingSlash: true,
}

export = HospitalRun
