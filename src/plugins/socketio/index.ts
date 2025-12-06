/**
 * Socket.io plugin for Fastify
 * Provides real-time communication capabilities
 */

import { FastifyPluginAsync } from 'fastify'
import { Server as SocketIOServer } from 'socket.io'
import fp from 'fastify-plugin'

declare module 'fastify' {
  interface FastifyInstance {
    io: SocketIOServer
  }
}

const socketIOPlugin: FastifyPluginAsync = async (fastify) => {
  // Create Socket.io server
  const io = new SocketIOServer(fastify.server, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:3001',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  })

  // Store in Fastify instance
  fastify.decorate('io', io)

  // Connection handling
  io.on('connection', (socket) => {
    fastify.log.info({ socketId: socket.id }, 'Socket.io client connected')

    // Handle subscription to resources
    socket.on('subscribe', (resource: string) => {
      socket.join(`resource:${resource}`)
      fastify.log.debug({ socketId: socket.id, resource }, 'Client subscribed to resource')
    })

    // Handle unsubscription from resources
    socket.on('unsubscribe', (resource: string) => {
      socket.leave(`resource:${resource}`)
      fastify.log.debug({ socketId: socket.id, resource }, 'Client unsubscribed from resource')
    })

    // Handle disconnection
    socket.on('disconnect', (reason) => {
      fastify.log.info({ socketId: socket.id, reason }, 'Socket.io client disconnected')
    })

    // Handle errors
    socket.on('error', (error) => {
      fastify.log.error({ socketId: socket.id, error }, 'Socket.io error')
    })
  })

  // Graceful shutdown
  fastify.addHook('onClose', async () => {
    io.close()
    fastify.log.info('Socket.io server closed')
  })

  fastify.log.info('Socket.io plugin registered')
}

export default fp(socketIOPlugin, {
  name: 'socketio',
  dependencies: [],
})

/**
 * Helper function to emit real-time events
 */
export function emitRealtimeEvent(
  fastify: any,
  resource: string,
  event: {
    type: 'create' | 'update' | 'delete' | 'patch'
    id?: string
    data?: any
  }
) {
  const eventData = {
    type: event.type,
    resource,
    id: event.id,
    data: event.data,
    timestamp: Date.now(),
  }

  // Emit to resource-specific room
  fastify.io.to(`resource:${resource}`).emit('realtime:event', eventData)

  // Also emit resource-specific event
  fastify.io.to(`resource:${resource}`).emit(`realtime:${resource}`, event.data)
}

