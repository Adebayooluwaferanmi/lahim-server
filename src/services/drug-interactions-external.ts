/**
 * External Drug Interaction API Integrations
 * 
 * This module provides integration with external drug interaction APIs:
 * - RxNorm API (free, from NLM)
 * - DrugBank API (requires API key)
 * 
 * Falls back to local database if external APIs are unavailable or not configured.
 */

import { DrugInteraction } from './drug-interactions'

interface DrugBankInteraction {
  severity: 'major' | 'moderate' | 'minor'
  description: string
  clinicalSignificance: string
  recommendation?: string
}

/**
 * Get RxNorm API base URL from environment
 */
const RXNORM_API_BASE = process.env.RXNORM_API_BASE || 'https://rxnav.nlm.nih.gov/REST'

/**
 * Get DrugBank API key from environment
 */
const DRUGBANK_API_KEY = process.env.DRUGBANK_API_KEY
const DRUGBANK_API_BASE = process.env.DRUGBANK_API_BASE || 'https://api.drugbank.com/v1'

/**
 * Normalize medication name for API lookup
 */
function normalizeMedicationName(name: string): string {
  return name.toLowerCase().trim()
}

/**
 * Search for RxNorm concept ID by medication name
 */
async function getRxNormConceptId(medicationName: string): Promise<string | null> {
  try {
    const normalized = normalizeMedicationName(medicationName)
    const response = await fetch(
      `${RXNORM_API_BASE}/drugs.json?name=${encodeURIComponent(normalized)}`
    )

    if (!response.ok) {
      return null
    }

    const data = await response.json() as any
    if (data.drugGroup?.conceptGroup?.[0]?.conceptProperties?.[0]?.rxcui) {
      return data.drugGroup.conceptGroup[0].conceptProperties[0].rxcui
    }

    return null
  } catch (error) {
    console.error('RxNorm API error:', error)
    return null
  }
}

/**
 * Check drug interactions using RxNorm API
 * Note: RxNorm doesn't directly provide interaction data, but we can use it
 * to normalize drug names and then check against other sources
 */
async function checkRxNormInteractions(_medications: string[]): Promise<DrugInteraction[]> {
  // RxNorm is primarily for drug name normalization
  // For actual interactions, we'd need to use DrugBank or other sources
  // This is a placeholder for future integration
  return []
}

/**
 * Check drug interactions using DrugBank API
 */
async function checkDrugBankInteractions(medications: string[]): Promise<DrugInteraction[]> {
  if (!DRUGBANK_API_KEY) {
    return []
  }

  try {
    const interactions: DrugInteraction[] = []

    // DrugBank requires checking pairs of drugs
    for (let i = 0; i < medications.length; i++) {
      for (let j = i + 1; j < medications.length; j++) {
        const med1 = normalizeMedicationName(medications[i])
        const med2 = normalizeMedicationName(medications[j])

        try {
          // DrugBank API endpoint for drug interactions
          // Note: This is a simplified example - actual DrugBank API may have different endpoints
          const response = await fetch(
            `${DRUGBANK_API_BASE}/drugs/${encodeURIComponent(med1)}/interactions/${encodeURIComponent(med2)}`,
            {
              headers: {
                'Authorization': `Bearer ${DRUGBANK_API_KEY}`,
                'Content-Type': 'application/json',
              },
            }
          )

          if (response.ok) {
            const data = await response.json() as DrugBankInteraction
            interactions.push({
              severity: data.severity,
              description: data.description,
              clinicalSignificance: data.clinicalSignificance,
              recommendation: data.recommendation,
            })
          }
        } catch (error) {
          // Silently fail for individual drug pairs
          console.error(`DrugBank interaction check failed for ${med1} + ${med2}:`, error)
        }
      }
    }

    return interactions
  } catch (error) {
    console.error('DrugBank API error:', error)
    return []
  }
}

/**
 * Check interactions using all available external APIs
 * Falls back gracefully if APIs are unavailable
 */
export async function checkExternalInteractions(
  medications: string[],
  localInteractions: DrugInteraction[]
): Promise<DrugInteraction[]> {
  const externalInteractions: DrugInteraction[] = []

  // Try DrugBank first (if API key is configured)
  if (DRUGBANK_API_KEY) {
    const drugBankInteractions = await checkDrugBankInteractions(medications)
    externalInteractions.push(...drugBankInteractions)
  }

  // Try RxNorm (for normalization, though it doesn't provide direct interactions)
  // This could be used to normalize names before checking other sources
  const rxNormInteractions = await checkRxNormInteractions(medications)
  externalInteractions.push(...rxNormInteractions)

  // Combine with local interactions, removing duplicates
  const allInteractions = [...localInteractions, ...externalInteractions]
  const uniqueInteractions = allInteractions.filter(
    (interaction, index, self) =>
      index === self.findIndex(
        (i) => i.description === interaction.description && i.severity === interaction.severity
      )
  )

  return uniqueInteractions
}

/**
 * Get medication information from RxNorm
 */
export async function getRxNormMedicationInfo(medicationName: string): Promise<{
  rxcui?: string
  name?: string
  synonyms?: string[]
} | null> {
  try {
    const rxcui = await getRxNormConceptId(medicationName)
    if (!rxcui) {
      return null
    }

    // Get drug properties
    const response = await fetch(`${RXNORM_API_BASE}/rxcui/${rxcui}/properties.json`)
    if (!response.ok) {
      return { rxcui }
    }

    const data = await response.json() as any
    return {
      rxcui,
      name: data.properties?.name,
      synonyms: data.properties?.synonym,
    }
  } catch (error) {
    console.error('RxNorm medication info error:', error)
    return null
  }
}


