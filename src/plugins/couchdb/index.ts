import { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import nano, { ServerScope, Configuration } from 'nano'
import { couchDBProxy } from './proxy.internal'

const COUCHDB_URL = process.env.COUCHDB_URL 
  ? String(process.env.COUCHDB_URL) 
  : 'http://dev:dev@localhost:5984'

const COUCHDB_ENABLED = process.env.COUCHDB_ENABLED !== 'false'

const couchDBPlugin: FastifyPluginAsync<Configuration> = async (fastify, options) => {
  const url = COUCHDB_URL || options?.url || 'http://localhost:5984'
  let couch: ServerScope | null = null
  let couchAvailable = false

  if (COUCHDB_ENABLED) {
    try {
      couch = nano({ ...options, url })
      
      // Test CouchDB connection (non-blocking)
      try {
        await couch.db.list()
        couchAvailable = true
        fastify.log.info('CouchDB connection established')
      } catch (error: any) {
        const errorMessage = error?.message || String(error)
        if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
          fastify.log.warn(
            { 
              error: errorMessage,
              url: url.replace(/\/\/.*@/, '//***:***@'), // Mask credentials in logs
              hint: 'CouchDB is not available. Services will continue without CouchDB. Start CouchDB or set COUCHDB_ENABLED=false to disable.'
            }, 
            'CouchDB connection failed - continuing without CouchDB'
          )
        } else {
          fastify.log.warn({ error }, 'CouchDB connection test failed - continuing without CouchDB')
        }
        couchAvailable = false
      }
    } catch (error) {
      fastify.log.warn({ error }, 'CouchDB initialization failed - continuing without CouchDB')
      couchAvailable = false
    }
  } else {
    fastify.log.info('CouchDB disabled via COUCHDB_ENABLED=false')
  }

  // Always decorate couch (even if null) so services can check availability
  fastify.decorate('couch', couch as ServerScope)
  fastify.decorate('couchAvailable', couchAvailable)
  
  // Only register proxy if CouchDB is available
  if (couchAvailable && couch) {
    fastify.register(couchDBProxy, { url })
  }
}

export default fp(couchDBPlugin, {
  name: 'couchdb',
  fastify: '4.x',
})

declare module 'fastify' {
  interface FastifyInstance {
    couch: ServerScope
    couchAvailable: boolean
  }
}
