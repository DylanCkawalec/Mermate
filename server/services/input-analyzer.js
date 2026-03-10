'use strict';

/**
 * Input Analyzer — Hidden intelligence engine for Mermate.
 *
 * Computes an InputProfile from raw user text: content type, maturity level,
 * architecture quality score, completeness score, inferred problem intent,
 * a shadow model of extracted entities/relationships/gaps, and a decision
 * recommendation (suggest / enhance / repair / validate / transform / render / stop).
 *
 * This module is entirely deterministic — no model calls. It runs in < 50ms
 * for typical input and is safe to call on every debounced keystroke.
 */

const { detect, CONTENT_STATES } = require('./input-detector');
const { selectDiagramType } = require('./diagram-selector');
const { validate } = require('./mermaid-validator');

// ---- Entity / relationship extraction patterns ----------------------------

const ENTITY_RE = /\b([\w-]+(?:\s+[\w-]+)?)\s+(?:service|server|gateway|api|proxy|broker|queue|cache|database|db|store|bucket|cluster|container|pod|lambda|function|worker|scheduler|registry|controller|manager|handler|adapter|client|browser|dashboard|portal|app|frontend|backend)\b/gi;
const NAMED_TECH_RE = /\b(Redis|Kafka|PostgreSQL|Postgres|MySQL|MongoDB|Mongo|DynamoDB|Dynamo|Elasticsearch|ElasticSearch|Snowflake|BigQuery|S3|CloudFront|CloudFlare|Stripe|Twilio|SendGrid|RabbitMQ|SQS|SNS|Kinesis|Pub\/Sub|gRPC|GraphQL|REST|WebSocket|Docker|Kubernetes|K8s|Nginx|HAProxy|Envoy|Istio|Terraform|Ansible|Jenkins|GitHub\s*Actions|CircleCI|ArgoCD|Prometheus|Grafana|Datadog|Sentry|PagerDuty|Slack|ERP|CRM|SSO|OAuth|JWT|SAML)\b/gi;
const STANDALONE_ENTITY_RE = /\b(user|client|browser|admin|operator|customer|external\s+system)\b/gi;

const RELATIONSHIP_VERB_RE = /\b(sends?\s+to|calls?|connects?\s+to|routes?\s+to|triggers?|requests?|reads?\s+from|writes?\s+to|stores?\s+in|queries?|goes?\s+to|flows?\s+to|talks?\s+to|uses?|emits?\s+to|publishes?\s+to|subscribes?\s+to|forwards?\s+to|fetches?\s+from|posts?\s+to|logs?\s+to|redirects?\s+to|proxies?\s+to|delegates?\s+to|dispatches?\s+to|passes?\s+to|consumes?|produces?|hits?|invokes?|notifies?|alerts?)\b/gi;

const FAILURE_RE = /\b(fail|failure|error|retry|retries|timeout|dead.?letter|dlq|fallback|rollback|circuit.?breaker|degrade|unavailable|reject|denied|unauthorized|403|401|500|5xx|4xx|crash|panic|oom|kill|abort|cancel)\b/gi;
const DECISION_RE = /\b(if|when|validate|check|approve|reject|gate|decision|condition|verify|unless|otherwise|on\s+success|on\s+failure|on\s+error)\b/gi;
const BOUNDARY_RE = /\b(layer|boundary|domain|zone|namespace|subnet|vpc|region|cluster|group|module|package|tier)\b/gi;
const CONSTRAINT_RE = /\b(sla|latency|throughput|rate.?limit|quota|budget|threshold|max|min|at\s+least|at\s+most|within\s+\d|idempoten|exactly.?once|at.?least.?once|at.?most.?once)\b/gi;
const ENDSTATE_RE  = /\b(return|respond|redirect|complete|succeed|finish|done|output|result|deliver|deploy|render|display|show|notify|confirm|acknowledge)\b/gi;
const BEGINNING_RE = /\b(user|client|browser|request|trigger|start|begin|initiate|submit|upload|push|send|emit|fire|invoke|open)\b/gi;

// ---- Helpers --------------------------------------------------------------

function uniqueMatches(text, re) {
  const matches = text.match(re) || [];
  return [...new Set(matches.map(m => m.toLowerCase().trim()))];
}

function countMatches(text, re) {
  return (text.match(re) || []).length;
}

function wordCount(text) {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

// ---- Shadow model extraction ----------------------------------------------

function extractShadow(text) {
  const entities = [];
  const seen = new Set();

  function addEntity(name, type, source) {
    const key = name.toLowerCase();
    if (seen.has(key) || key.length < 2) return;
    seen.add(key);
    entities.push({ name, type, source });
  }

  // Named composite entities (e.g., "auth service", "API gateway")
  let m;
  const entityRe = new RegExp(ENTITY_RE.source, 'gi');
  while ((m = entityRe.exec(text)) !== null) {
    addEntity(m[0].trim(), 'component', 'pattern');
  }

  // Named technologies
  const techRe = new RegExp(NAMED_TECH_RE.source, 'gi');
  while ((m = techRe.exec(text)) !== null) {
    addEntity(m[0].trim(), 'technology', 'explicit');
  }

  // Standalone actors
  const actorRe = new RegExp(STANDALONE_ENTITY_RE.source, 'gi');
  while ((m = actorRe.exec(text)) !== null) {
    addEntity(m[0].trim(), 'actor', 'pattern');
  }

  // Relationships: extract from sentences, handling compound verbs ("validates and routes to")
  const relationships = [];
  const sentences = text.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 5);

  // Split compound sentences on " and " that precedes a verb, then extract from each clause
  const clauses = [];
  for (const sentence of sentences) {
    const parts = sentence.split(/\s+and\s+(?=\w+\s+(?:to|from|in)\b)/i);
    if (parts.length > 1) {
      const subject = parts[0].split(/\s+/).slice(0, 4).join(' ');
      clauses.push(parts[0]);
      for (let i = 1; i < parts.length; i++) {
        clauses.push(subject + ' ' + parts[i]);
      }
    } else {
      clauses.push(sentence);
    }
  }

  const verbRe = new RegExp(RELATIONSHIP_VERB_RE.source, 'gi');
  for (const clause of clauses) {
    const verbMatch = verbRe.exec(clause);
    if (verbMatch) {
      const before = clause.slice(0, verbMatch.index).trim();
      const after  = clause.slice(verbMatch.index + verbMatch[0].length).trim();
      if (before && after) {
        const fromWords = before.split(/\s+/).slice(-3).join(' ');
        const toWords   = after.split(/\s+/).slice(0, 3).join(' ');
        relationships.push({
          from: fromWords,
          to: toWords,
          verb: verbMatch[0].trim(),
          type: /emit|publish|trigger|fire/.test(verbMatch[0]) ? 'async' : 'runtime',
        });
      }
    }
    verbRe.lastIndex = 0;
  }

  // Failure paths
  const failureTerms = uniqueMatches(text, FAILURE_RE);
  const failurePaths = [];
  for (const sentence of sentences) {
    const hasFail = FAILURE_RE.test(sentence);
    FAILURE_RE.lastIndex = 0;
    if (hasFail) {
      failurePaths.push({ description: sentence.slice(0, 120) });
    }
  }

  // Boundaries
  const boundaryTerms = uniqueMatches(text, BOUNDARY_RE);

  // Gaps
  const gaps = [];
  if (failurePaths.length === 0 && entities.length >= 3) {
    gaps.push('no failure or error handling path described');
  }
  if (countMatches(text, ENDSTATE_RE) === 0 && entities.length >= 2) {
    gaps.push('no clear end state or response described');
  }
  if (countMatches(text, BEGINNING_RE) === 0 && entities.length >= 2) {
    gaps.push('no clear trigger or entry point described');
  }
  if (countMatches(text, CONSTRAINT_RE) === 0 && entities.length >= 5) {
    gaps.push('no constraints, SLAs, or limits mentioned');
  }
  if (boundaryTerms.length === 0 && entities.length >= 6) {
    gaps.push('no architectural boundaries or layers defined');
  }

  return { entities, relationships, failurePaths, boundaryTerms, gaps };
}

// ---- Maturity classification ----------------------------------------------

function classifyMaturity(text, signals, shadow) {
  const words = wordCount(text);
  const entityCount = shadow.entities.length;
  const relCount = shadow.relationships.length;
  const hasFailure = shadow.failurePaths.length > 0;
  const hasEnd = countMatches(text, ENDSTATE_RE) > 0;
  const hasBegin = countMatches(text, BEGINNING_RE) > 0;
  const hasDecision = countMatches(text, DECISION_RE) > 0;

  // render-ready: already valid Mermaid
  if (signals.mmdDirectiveMatch) {
    const v = validate(text);
    if (v.valid) return 'render-ready';
  }

  // fragment
  if (words < 15 || entityCount < 2) return 'fragment';

  // complete: has beginning, process, end state, and failure handling
  if (hasBegin && relCount >= 3 && hasEnd && hasFailure) return 'complete';

  // complete (relaxed): strong multi-entity architecture with failure paths and good quality
  if (entityCount >= 5 && hasFailure && hasEnd && hasBegin) return 'complete';

  // structured: enough entities and relationships with some branching
  if (entityCount >= 5 && (relCount >= 2 || hasDecision || hasFailure)) return 'structured';

  // developing: has some entities and at least one relationship
  if (entityCount >= 2 && (relCount >= 1 || words >= 30)) return 'developing';

  // default
  return words >= 15 ? 'developing' : 'fragment';
}

// ---- Quality scoring ------------------------------------------------------

function scoreQuality(text, shadow) {
  const factors = {};

  // Entity clarity: named techs and composite entities vs standalone actors
  const named = shadow.entities.filter(e => e.source === 'explicit' || e.type === 'component').length;
  const total = Math.max(shadow.entities.length, 1);
  factors.entityClarity = Math.min(1.0, named / total);

  // Relationship explicitness
  const explicitVerbs = shadow.relationships.length;
  const vagueConnectors = countMatches(text, /\band\b|\bthen\b|\balso\b/gi);
  const totalConnectors = Math.max(explicitVerbs + vagueConnectors, 1);
  factors.relationshipExplicitness = Math.min(1.0, explicitVerbs / totalConnectors);

  // Failure path presence
  factors.failurePathPresence = shadow.failurePaths.length > 0 ? 1.0
    : shadow.failurePaths.length === 0 && shadow.entities.length < 3 ? 0.5 : 0.0;

  // Boundary definition
  factors.boundaryDefinition = shadow.boundaryTerms.length > 0 ? 1.0
    : shadow.entities.length < 5 ? 0.5 : 0.0;

  // Data store specificity
  const techEntities = shadow.entities.filter(e => e.source === 'explicit').length;
  const storeRefs = countMatches(text, /\b(database|db|cache|store|storage|queue)\b/gi);
  const totalStores = Math.max(techEntities + storeRefs, 1);
  factors.dataStoreSpecificity = Math.min(1.0, techEntities / totalStores);

  // Flow completeness
  const hasBegin = countMatches(text, BEGINNING_RE) > 0;
  const hasEnd = countMatches(text, ENDSTATE_RE) > 0;
  const hasMiddle = shadow.relationships.length >= 2;
  factors.flowCompleteness = ((hasBegin ? 1 : 0) + (hasMiddle ? 1 : 0) + (hasEnd ? 1 : 0)) / 3;

  // Constraint presence
  factors.constraintPresence = countMatches(text, CONSTRAINT_RE) > 0 ? 1.0
    : shadow.entities.length < 4 ? 0.5 : 0.0;

  const weights = {
    entityClarity: 0.20,
    relationshipExplicitness: 0.20,
    failurePathPresence: 0.15,
    boundaryDefinition: 0.15,
    dataStoreSpecificity: 0.10,
    flowCompleteness: 0.10,
    constraintPresence: 0.10,
  };

  let score = 0;
  for (const [key, weight] of Object.entries(weights)) {
    score += (factors[key] || 0) * weight;
  }

  return { score: +score.toFixed(3), factors };
}

// ---- Completeness scoring -------------------------------------------------

function scoreCompleteness(text, shadow, maturity) {
  const factors = {};

  factors.hasBeginning = countMatches(text, BEGINNING_RE) > 0 ? 1.0 : 0.0;
  factors.hasProcess = shadow.relationships.length >= 2 ? 1.0
    : shadow.relationships.length === 1 ? 0.5 : 0.0;
  factors.hasEndState = countMatches(text, ENDSTATE_RE) > 0 ? 1.0 : 0.0;
  factors.hasFailurePath = shadow.failurePaths.length > 0 ? 1.0 : 0.0;

  // Sufficiency: are the entities and relationships proportionate?
  // Cap the divisor at 6 so high-entity architectures are not unfairly penalized.
  const entityCount = shadow.entities.length;
  const relCount = shadow.relationships.length;
  if (entityCount >= 3 && relCount >= 2 && maturity !== 'fragment') {
    const cappedDivisor = Math.min(entityCount - 1, 6);
    factors.sufficientForProblem = Math.min(1.0, relCount / Math.max(cappedDivisor, 1));
  } else if (entityCount >= 5 && maturity === 'complete') {
    factors.sufficientForProblem = 0.8;
  } else {
    factors.sufficientForProblem = 0.0;
  }

  const weights = {
    hasBeginning: 0.20,
    hasProcess: 0.25,
    hasEndState: 0.20,
    hasFailurePath: 0.15,
    sufficientForProblem: 0.20,
  };

  let score = 0;
  for (const [key, weight] of Object.entries(weights)) {
    score += (factors[key] || 0) * weight;
  }

  return { score: +score.toFixed(3), factors };
}

// ---- Intent inference -----------------------------------------------------

const DOMAIN_PATTERNS = {
  auth:          /\b(auth|login|jwt|oauth|sso|saml|credential|token|session|password|mfa|2fa)\b/i,
  payment:       /\b(payment|checkout|billing|stripe|invoice|charge|refund|subscription|order)\b/i,
  deployment:    /\b(deploy|ci\/?cd|pipeline|canary|rollout|release|build|staging|production)\b/i,
  dataPipeline:  /\b(etl|ingest|transform|load|warehouse|analytics|batch|stream|data\s+lake)\b/i,
  eventDriven:   /\b(event|kafka|queue|pub.?sub|consumer|producer|broker|message|emit|subscribe)\b/i,
  infrastructure:/\b(kubernetes|docker|aws|gcp|azure|terraform|vpc|subnet|load\s+balancer|cdn)\b/i,
};

const GOAL_PATTERNS = {
  architectureOverview: /\b(architecture|overview|system\s+design|infrastructure|platform)\b/i,
  sequenceFlow:         /\b(sequence|step\s+by\s+step|flow\s+between|request.?response|handshake)\b/i,
  stateMachine:         /\b(state|lifecycle|transition|mode|status|pending|running|failed)\b/i,
  dataModel:            /\b(entity|relationship|schema|table|column|foreign\s+key|cardinality)\b/i,
  pipeline:             /\b(pipeline|workflow|ci\/?cd|etl|process\s+flow)\b/i,
};

function inferIntent(text) {
  let problemDomain = 'general';
  let bestDomainScore = 0;
  for (const [domain, re] of Object.entries(DOMAIN_PATTERNS)) {
    const score = countMatches(text, re);
    if (score > bestDomainScore) {
      bestDomainScore = score;
      problemDomain = domain;
    }
  }

  let diagramGoal = 'unknown';
  let bestGoalScore = 0;
  for (const [goal, re] of Object.entries(GOAL_PATTERNS)) {
    const score = countMatches(text, re);
    if (score > bestGoalScore) {
      bestGoalScore = score;
      diagramGoal = goal;
    }
  }

  // Infer a one-line problem statement from the first sentence
  const firstSentence = text.split(/[.!?\n]/).find(s => s.trim().length > 10);
  const inferredProblem = firstSentence ? firstSentence.trim().slice(0, 120) : null;

  return { problemDomain, diagramGoal, inferredProblem };
}

// ---- Decision policy ------------------------------------------------------

function decideAction(contentState, maturity, qualityScore, completenessScore, validationResult) {
  // Valid Mermaid that compiles → render (or stop if already good)
  if (contentState === 'mmd' && validationResult && validationResult.valid) {
    return 'render';
  }

  // Invalid Mermaid → repair
  if (contentState === 'mmd' && validationResult && !validationResult.valid) {
    return 'repair';
  }

  // Hybrid content → repair
  if (contentState === 'hybrid') {
    return 'repair';
  }

  // Already render-ready
  if (maturity === 'render-ready') {
    return 'transform';
  }

  // Complete and high quality → stop
  if (maturity === 'complete' && qualityScore >= 0.7) {
    return 'stop';
  }

  // Complete but low quality → enhance
  if (maturity === 'complete' && qualityScore < 0.7) {
    return 'enhance';
  }

  // Structured → suggest targeted additions
  if (maturity === 'structured') {
    return completenessScore >= 0.75 ? 'stop' : 'suggest';
  }

  // Developing → suggest continuations
  if (maturity === 'developing') {
    return 'suggest';
  }

  // Fragment → suggest
  return 'suggest';
}

// ---- Hint generation ------------------------------------------------------

function generateHint(recommendation, maturity, gaps, contentState) {
  if (contentState === 'mmd') {
    return recommendation === 'render'
      ? 'Valid Mermaid \u00b7 press Render when ready'
      : 'Mermaid has issues \u00b7 press Render to attempt repair and compile';
  }

  switch (recommendation) {
    case 'stop':
      return 'Looks ready \u00b7 press Render to generate your diagram';
    case 'render':
      return 'Ready to render';
    case 'transform':
      return 'Good enough to diagram \u00b7 press Render';
    case 'enhance':
      return gaps.length > 0
        ? `Consider: ${gaps[0]}`
        : 'Press \u2318\u23ce to refine before rendering';
    case 'repair':
      return 'Mixed content detected \u00b7 press Render to extract and compile';
    case 'suggest':
      if (maturity === 'fragment') {
        return 'Describe your system, actors, and flows \u00b7 Tab to accept suggestions';
      }
      if (gaps.length > 0) {
        return `Tip: ${gaps[0]} \u00b7 Tab to accept suggestions`;
      }
      return 'Keep going \u00b7 Tab to accept suggestions';
    default:
      return 'Type an idea \u00b7 \u2318\u23ce to enhance \u00b7 Tab to accept suggestions';
  }
}

// ---- Main entry point -----------------------------------------------------

/**
 * Analyze user input and produce a full InputProfile.
 *
 * @param {string} text - Raw user input (already trimmed)
 * @param {string} [mode='idea'] - Current UI mode (idea, md, mmd)
 * @returns {object} InputProfile
 */
function analyze(text, mode = 'idea') {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return {
      contentState: 'text',
      signals: {},
      maturity: 'fragment',
      qualityScore: 0,
      qualityFactors: {},
      completenessScore: 0,
      completenessFactors: {},
      intent: { problemDomain: 'general', diagramGoal: 'unknown', inferredProblem: null },
      shadow: { entities: [], relationships: [], failurePaths: [], boundaryTerms: [], gaps: [] },
      recommendation: 'suggest',
      hint: 'Describe what you want to diagram \u00b7 start with the problem you\'re solving',
      diagramSelection: null,
    };
  }

  const source = text.trim();
  const { state: contentState, signals } = detect(source);

  // For mmd content, run validation directly
  let validationResult = null;
  if (contentState === 'mmd') {
    validationResult = validate(source);
  }

  const shadow = extractShadow(source);
  const maturity = classifyMaturity(source, signals, shadow);
  const quality = scoreQuality(source, shadow);
  const completeness = scoreCompleteness(source, shadow, maturity);
  const intent = inferIntent(source);
  const diagramSelection = contentState === 'text' ? selectDiagramType(source) : null;

  const recommendation = decideAction(
    contentState, maturity, quality.score, completeness.score, validationResult,
  );

  const hint = generateHint(recommendation, maturity, shadow.gaps, contentState);

  return {
    contentState,
    signals,
    maturity,
    qualityScore: quality.score,
    qualityFactors: quality.factors,
    completenessScore: completeness.score,
    completenessFactors: completeness.factors,
    intent,
    shadow,
    recommendation,
    hint,
    diagramSelection,
    validation: validationResult,
  };
}

module.exports = {
  analyze,
  extractShadow,
  classifyMaturity,
  scoreQuality,
  scoreCompleteness,
  inferIntent,
  decideAction,
  generateHint,
};
