import { Server, IncomingMessage, ServerResponse } from 'http'
import { FastifyInstance } from 'fastify'
import { checkExternalInteractions } from './drug-interactions-external'

/**
 * Drug Interaction Service
 * 
 * This service provides drug-drug interaction checking.
 * Currently uses a basic rule-based system. Can be extended to integrate with:
 * - RxNorm API
 * - DrugBank API
 * - First Databank (FDB) API
 * - Other commercial drug interaction databases
 */

export interface DrugInteraction {
  severity: 'major' | 'moderate' | 'minor'
  description: string
  clinicalSignificance: string
  recommendation?: string
}

// Basic drug interaction database (can be replaced with external API)
const INTERACTION_DATABASE: Record<string, Record<string, DrugInteraction>> = {
  // Warfarin interactions (common anticoagulant)
  'warfarin': {
    'aspirin': {
      severity: 'major',
      description: 'Increased risk of bleeding',
      clinicalSignificance: 'Concurrent use may significantly increase the risk of bleeding',
      recommendation: 'Monitor INR closely and consider alternative pain management',
    },
    'ibuprofen': {
      severity: 'major',
      description: 'Increased risk of bleeding',
      clinicalSignificance: 'NSAIDs may increase anticoagulant effects',
      recommendation: 'Avoid concurrent use or monitor closely',
    },
    'acetaminophen': {
      severity: 'moderate',
      description: 'Potential for increased INR',
      clinicalSignificance: 'High doses may enhance anticoagulant effect',
      recommendation: 'Monitor INR if high doses are used',
    },
  },
  // ACE inhibitors interactions
  'lisinopril': {
    'potassium': {
      severity: 'moderate',
      description: 'Risk of hyperkalemia',
      clinicalSignificance: 'May increase potassium levels',
      recommendation: 'Monitor serum potassium levels',
    },
    'spironolactone': {
      severity: 'major',
      description: 'Increased risk of hyperkalemia',
      clinicalSignificance: 'Both drugs can increase potassium',
      recommendation: 'Monitor potassium levels closely',
    },
  },
  // Statin interactions
  'atorvastatin': {
    'erythromycin': {
      severity: 'major',
      description: 'Increased risk of myopathy',
      clinicalSignificance: 'May increase statin levels and risk of muscle toxicity',
      recommendation: 'Consider alternative antibiotic or reduce statin dose',
    },
  },
  // Metformin interactions
  'metformin': {
    'alcohol': {
      severity: 'moderate',
      description: 'Risk of lactic acidosis',
      clinicalSignificance: 'Alcohol may increase risk of lactic acidosis',
      recommendation: 'Limit alcohol consumption',
    },
  },
}

/**
 * Normalize medication name for lookup
 */
function normalizeMedicationName(name: string): string {
  return name.toLowerCase().trim()
}

/**
 * Check for interactions between medications
 */
function checkInteractions(medications: string[]): DrugInteraction[] {
  const interactions: DrugInteraction[] = []
  const normalized = medications.map(normalizeMedicationName)

  // Check all pairs
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      const med1 = normalized[i]
      const med2 = normalized[j]

      // Check both directions (A->B and B->A)
      if (INTERACTION_DATABASE[med1]?.[med2]) {
        interactions.push(INTERACTION_DATABASE[med1][med2])
      } else if (INTERACTION_DATABASE[med2]?.[med1]) {
        interactions.push(INTERACTION_DATABASE[med2][med1])
      }
    }
  }

  return interactions
}

export default async (
  fastify: FastifyInstance<Server, IncomingMessage, ServerResponse>,
  _: {},
) => {
  // POST /drug-interactions/check - Check for drug interactions
  fastify.post('/drug-interactions/check', async (request, reply) => {
    try {
      const { medications } = request.body as { medications: string[] }

      if (!medications || !Array.isArray(medications) || medications.length < 2) {
        reply.code(400).send({ 
          error: 'At least two medications are required',
          interactions: []
        })
        return
      }

      // Check local interactions first
      const localInteractions = checkInteractions(medications)

      // Then check external APIs (RxNorm, DrugBank, etc.)
      const externalInteractions = await checkExternalInteractions(medications, localInteractions)

      // Combine results
      const interactions = externalInteractions.length > 0 ? externalInteractions : localInteractions

      fastify.log.info({ 
        medicationCount: medications.length, 
        interactionCount: interactions.length,
        externalSources: externalInteractions.length > 0 ? 'used' : 'not_used'
      }, 'drug_interactions.checked')

      reply.send({ 
        medications,
        interactions,
        hasInteractions: interactions.length > 0,
        hasMajorInteractions: interactions.some(i => i.severity === 'major'),
      })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'drug_interactions.check_failed')
      reply.code(500).send({ error: 'Failed to check drug interactions' })
    }
  })

  // GET /drug-interactions/:medication - Get known interactions for a medication
  fastify.get('/drug-interactions/:medication', async (request, reply) => {
    try {
      const { medication } = request.params as { medication: string }
      const normalized = normalizeMedicationName(medication)
      
      const interactions = INTERACTION_DATABASE[normalized] || {}
      const interactionList = Object.entries(interactions).map(([drug, interaction]) => ({
        drug,
        ...interaction,
      }))

      reply.send({ 
        medication,
        interactions: interactionList,
        count: interactionList.length,
      })
    } catch (error: unknown) {
      fastify.log.error(error as Error, 'drug_interactions.get_failed')
      reply.code(500).send({ error: 'Failed to get drug interactions' })
    }
  })

}

