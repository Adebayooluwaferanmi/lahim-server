/**
 * HL7 v2.5 Message Formatter
 * Generates HL7 ORU^R01 messages for laboratory results
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
 * Escape HL7 field separators
 */
function escapeHL7Field(value: string | undefined | null): string {
  if (!value) return ''
  return String(value)
    .replace(/\\/g, '\\E\\')
    .replace(/\^/g, '\\S\\')
    .replace(/\|/g, '\\F\\')
    .replace(/~/g, '\\R\\')
    .replace(/&/g, '\\T\\')
}

/**
 * Format HL7 timestamp (YYYYMMDDHHMMSS)
 */
function formatHL7Timestamp(date?: string | Date): string {
  if (!date) {
    const now = new Date()
    return now.toISOString().replace(/[-:T.]/g, '').substring(0, 14)
  }
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toISOString().replace(/[-:T.]/g, '').substring(0, 14)
}

/**
 * Generate HL7 MSH (Message Header) segment
 */
function generateMSH(facilityInfo?: FacilityInfo): string {
  const timestamp = formatHL7Timestamp()
  const sendingApp = facilityInfo?.name || 'LaHIM'
  const sendingFacility = facilityInfo?.id || 'LAB'
  const receivingApp = 'HIS'
  const receivingFacility = 'HOSPITAL'
  
  return [
    'MSH',
    '^~\\&', // Field separator, encoding characters
    escapeHL7Field(sendingApp),
    escapeHL7Field(sendingFacility),
    escapeHL7Field(receivingApp),
    escapeHL7Field(receivingFacility),
    formatHL7Timestamp(), // Message date/time
    '', // Security
    'ORU^R01^ORU_R01', // Message type
    `MSG${timestamp}`, // Message control ID
    'P', // Processing ID (P=Production, T=Test)
    '2.5', // Version ID
    '', // Sequence number
    '', // Continuation pointer
    'AL', // Accept acknowledgment type
    'ER', // Application acknowledgment type
    'NE', // Country code
  ].join('|')
}

/**
 * Generate HL7 PID (Patient Identification) segment
 */
function generatePID(patientInfo: PatientInfo): string {
  const mrn = patientInfo.mrn || patientInfo.id
  const name = patientInfo.name || ''
  const nameParts = name.split(' ')
  const lastName = nameParts[0] || ''
  const firstName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : ''
  
  return [
    'PID',
    '1', // Set ID
    '', // Patient ID (external)
    mrn, // Patient ID (internal) - MRN
    '', // Alternate patient ID
    `${lastName}^${firstName}^^^`, // Patient name
    '', // Mother's maiden name
    formatHL7Timestamp(patientInfo.dateOfBirth), // Date of birth
    patientInfo.gender || 'U', // Sex (M/F/U)
    '', // Patient alias
    '', // Race
    '', // Patient address
    '', // County code
    '', // Phone number
    '', // Phone number business
    '', // Primary language
    '', // Marital status
    '', // Religion
    '', // Patient account number
    '', // SSN
    '', // Driver's license number
    '', // Mother's identifier
    '', // Ethnic group
    '', // Birth place
    '', // Multiple birth indicator
    '', // Birth order
    '', // Citizenship
    '', // Veterans military status
    '', // Nationality
    '', // Patient death date and time
    '', // Patient death indicator
  ].join('|')
}

/**
 * Generate HL7 OBR (Observation Request) segment
 */
function generateOBR(
  orderNumber: string,
  testCode: string,
  testName: string,
  _specimenId?: string,
  collectedDateTime?: string
): string {
  return [
    'OBR',
    '1', // Set ID
    orderNumber, // Placer order number
    '', // Filler order number
    `${testCode}^${testName}^LOINC`, // Universal service identifier
    '', // Priority
    '', // Requested date/time
    collectedDateTime ? formatHL7Timestamp(collectedDateTime) : '', // Observation date/time
    '', // Observation end date/time
    '', // Collection volume
    '', // Collector identifier
    '', // Specimen action code
    '', // Danger code
    '', // Relevant clinical information
    collectedDateTime ? formatHL7Timestamp(collectedDateTime) : '', // Specimen received date/time
    '', // Specimen source
    '', // Ordering provider
    '', // Order callback phone number
    '', // Placer field 1
    '', // Placer field 2
    '', // Filler field 1
    '', // Filler field 2
    '', // Results Rpt/Status Chng - Date/Time
    '', // Charge to practice
    '', // Diagnostic service section ID
    '', // Result status
    '', // Parent result
    '', // Quantity/timing
    '', // Result copies to
    '', // Parent
    '', // Transportation mode
    '', // Reason for study
    '', // Principal result interpreter
    '', // Assistant result interpreter
    '', // Technician
    '', // Transcriptionist
    '', // Scheduled date/time
    '', // Number of sample containers
    '', // Transport logistics of collected sample
    '', // Collector's comment
    '', // Transport arrangement responsibility
    '', // Transport arranged
    '', // Escort required
    '', // Planned patient transport comment
  ].join('|')
}

/**
 * Generate HL7 OBX (Observation/Result) segment
 */
function generateOBX(
  sequence: number,
  testCode: string,
  testName: string,
  result: LabResult
): string {
  let valueType = 'NM' // Numeric
  let observationValue = ''
  let units = ''
  let referenceRange = ''
  
  if (result.resultType === 'numeric' && result.numericValue !== undefined) {
    observationValue = String(result.numericValue)
    units = result.unit || ''
    if (result.referenceRange) {
      const { low, high } = result.referenceRange
      referenceRange = `${low || ''}-${high || ''}`
    }
  } else if (result.resultType === 'coded' && result.codedValue) {
    valueType = 'CE' // Coded element
    observationValue = `${result.codedValue.code}^${result.codedValue.display}`
  } else if (result.resultType === 'text' && result.textValue) {
    valueType = 'TX' // Text
    observationValue = result.textValue
  } else {
    valueType = 'TX'
    observationValue = 'N/A'
  }
  
  const abnormalFlags = result.flags?.join('^') || ''
  const status = result.status === 'final' ? 'F' : 'P' // F=Final, P=Preliminary
  
  return [
    'OBX',
    String(sequence), // Set ID
    valueType, // Value type
    `${testCode}^${testName}^LOINC`, // Observation identifier
    '', // Observation sub-ID
    observationValue, // Observation value
    units, // Units
    referenceRange, // Reference range
    abnormalFlags, // Abnormal flags
    '', // Probability
    '', // Nature of abnormal test
    status, // Observation result status
    '', // Date last observation normal values
    '', // User defined access checks
    formatHL7Timestamp(result.reportedDateTime), // Date/time of observation
    '', // Producer's ID
    '', // Responsible observer
    '', // Observation method
  ].join('|')
}

/**
 * Generate complete HL7 ORU^R01 message for lab results
 */
export function generateHL7Message(
  results: LabResult[],
  patientInfo: PatientInfo,
  facilityInfo?: FacilityInfo,
  orderNumber?: string,
  specimenId?: string,
  collectedDateTime?: string
): string {
  if (results.length === 0) {
    throw new Error('No results provided for HL7 message generation')
  }
  
  const segments: string[] = []
  
  // MSH - Message Header
  segments.push(generateMSH(facilityInfo))
  
  // PID - Patient Identification
  segments.push(generatePID(patientInfo))
  
  // OBR - Observation Request (one per test or panel)
  const firstResult = results[0]
  const testCode = firstResult.testCode?.coding?.[0]?.code || ''
  const testName = firstResult.testName || testCode
  segments.push(generateOBR(
    orderNumber || `ORD${Date.now()}`,
    testCode,
    testName,
    specimenId,
    collectedDateTime
  ))
  
  // OBX - Observation/Result (one per result)
  results.forEach((result, index) => {
    const resultTestCode = result.testCode?.coding?.[0]?.code || testCode
    const resultTestName = result.testName || result.testCode?.coding?.[0]?.display || testName
    segments.push(generateOBX(index + 1, resultTestCode, resultTestName, result))
  })
  
  return segments.join('\r') + '\r'
}

