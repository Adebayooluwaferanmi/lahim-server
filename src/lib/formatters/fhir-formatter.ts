/**
 * FHIR R4 DiagnosticReport Formatter
 * Generates FHIR DiagnosticReport resources for laboratory results
 */

interface LabResult {
  id: string
  patientId: string
  testCode: {
    coding?: Array<{ code?: string; display?: string; system?: string }>
  }
  testName?: string
  resultType: 'numeric' | 'coded' | 'text' | 'microbiology'
  numericValue?: number
  unit?: string
  codedValue?: { code?: string; display?: string }
  textValue?: string
  referenceRange?: { low?: number; high?: number }
  reportedDateTime?: string
  status?: string
  flags?: string[]
}

interface PatientInfo {
  id: string
  name?: string
  dateOfBirth?: string
  gender?: string
  mrn?: string
}

interface FacilityInfo {
  name?: string
  address?: string
  id?: string
}

/**
 * Generate FHIR DiagnosticReport resource
 */
export function generateFHIRDiagnosticReport(
  results: LabResult[],
  patientInfo: PatientInfo,
  facilityInfo?: FacilityInfo,
  _orderNumber?: string,
  specimenId?: string,
  collectedDateTime?: string
): any {
  if (results.length === 0) {
    throw new Error('No results provided for FHIR DiagnosticReport generation')
  }
  
  const now = new Date().toISOString()
  const firstResult = results[0]
  const reportedDateTime = firstResult.reportedDateTime || now
  
  // Build observation resources for each result
  const observations = results.map((result) => {
    const testCode = result.testCode?.coding?.[0]?.code || ''
    const testDisplay = result.testName || result.testCode?.coding?.[0]?.display || testCode
    const testSystem = result.testCode?.coding?.[0]?.system || 'http://loinc.org'
    
    const observation: any = {
      resourceType: 'Observation',
      id: `obs-${result.id}`,
      status: result.status === 'final' ? 'final' : 'preliminary',
      category: [
        {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/observation-category',
              code: 'laboratory',
              display: 'Laboratory',
            },
          ],
        },
      ],
      code: {
        coding: [
          {
            system: testSystem,
            code: testCode,
            display: testDisplay,
          },
        ],
      },
      subject: {
        reference: `Patient/${patientInfo.id}`,
        display: patientInfo.name,
      },
      effectiveDateTime: reportedDateTime,
      issued: reportedDateTime,
    }
    
    // Add value based on result type
    if (result.resultType === 'numeric' && result.numericValue !== undefined) {
      observation.valueQuantity = {
        value: result.numericValue,
        unit: result.unit || '',
        system: 'http://unitsofmeasure.org',
        code: result.unit || '',
      }
      
      // Add reference range if available
      if (result.referenceRange) {
        observation.referenceRange = [
          {
            low: result.referenceRange.low !== undefined
              ? {
                  value: result.referenceRange.low,
                  unit: result.unit || '',
                  system: 'http://unitsofmeasure.org',
                  code: result.unit || '',
                }
              : undefined,
            high: result.referenceRange.high !== undefined
              ? {
                  value: result.referenceRange.high,
                  unit: result.unit || '',
                  system: 'http://unitsofmeasure.org',
                  code: result.unit || '',
                }
              : undefined,
          },
        ].filter((range) => range.low || range.high)
      }
      
      // Add interpretation flags
      if (result.flags && result.flags.length > 0) {
        const flagMeanings: Record<string, string> = {
          critical: 'CR',
          abnormal: 'A',
          'delta-check-failed': 'D',
        }
        observation.interpretation = result.flags
          .map((flag) => ({
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
                code: flagMeanings[flag] || 'N',
                display: flag,
              },
            ],
          }))
          .filter((i) => i.coding[0].code !== 'N')
      }
    } else if (result.resultType === 'coded' && result.codedValue) {
      observation.valueCodeableConcept = {
        coding: [
          {
            code: result.codedValue.code,
            display: result.codedValue.display,
          },
        ],
      }
    } else if (result.resultType === 'text' && result.textValue) {
      observation.valueString = result.textValue
    }
    
    // Add specimen reference if available
    if (specimenId) {
      observation.specimen = {
        reference: `Specimen/${specimenId}`,
      }
    }
    
    return observation
  })
  
  // Build DiagnosticReport resource
  const testCode = firstResult.testCode?.coding?.[0]?.code || ''
  const testDisplay = firstResult.testName || firstResult.testCode?.coding?.[0]?.display || testCode
  
  const diagnosticReport: any = {
    resourceType: 'DiagnosticReport',
    id: `dr-${Date.now()}`,
    status: 'final',
    category: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/v2-0074',
            code: 'LAB',
            display: 'Laboratory',
          },
        ],
      },
    ],
    code: {
      coding: [
        {
          system: 'http://loinc.org',
          code: testCode,
          display: testDisplay,
        },
      ],
    },
    subject: {
      reference: `Patient/${patientInfo.id}`,
      display: patientInfo.name,
    },
    effectiveDateTime: collectedDateTime || reportedDateTime,
    issued: reportedDateTime,
    performer: facilityInfo?.name
      ? [
          {
            display: facilityInfo.name,
          },
        ]
      : undefined,
    result: observations.map((obs) => ({
      reference: `Observation/${obs.id}`,
      display: obs.code.coding[0].display,
    })),
    conclusion: `Laboratory results for ${testDisplay}`,
  }
  
  // Add specimen reference if available
  if (specimenId) {
    diagnosticReport.specimen = [
      {
        reference: `Specimen/${specimenId}`,
      },
    ]
  }
  
  // Return as FHIR Bundle
  return {
    resourceType: 'Bundle',
    type: 'collection',
    timestamp: now,
    entry: [
      {
        fullUrl: `urn:uuid:${diagnosticReport.id}`,
        resource: diagnosticReport,
      },
      ...observations.map((obs) => ({
        fullUrl: `urn:uuid:${obs.id}`,
        resource: obs,
      })),
    ],
  }
}

