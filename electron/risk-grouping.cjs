"use strict";

// Stable issue identities are deliberately based on semantic topics/rules,
// not on a particular contract's clause numbers or wording.
const CANONICAL_ISSUES = [
  {
    id: "amount_consistency",
    topics: ["amount_consistency", "amount", "payment_amount"],
    rulePrefixes: ["amount."]
  },
  {
    id: "tax_compliance",
    topics: ["tax", "tax_compliance", "invoice_tax", "taxation"],
    rulePrefixes: ["tax.", "invoice.tax"]
  },
  {
    id: "dispute_resolution",
    topics: ["dispute", "dispute_resolution", "jurisdiction"],
    rulePrefixes: ["dispute."]
  },
  {
    id: "acceptance_quality",
    topics: ["acceptance", "acceptance_quality", "delivery_acceptance"],
    rulePrefixes: ["acceptance.", "timeline.acceptance"]
  }
];

function token(value) {
  return String(value || "").trim().toLowerCase();
}

function canonicalIssueId(finding = {}) {
  const explicit = finding.canonical_issue_id || finding.canonicalIssueId;
  if (explicit) return token(explicit);
  const aggregation = finding.aggregation_key || finding.risk_group;
  if (aggregation) return token(aggregation);
  const topic = token(finding.risk_topic || finding.topic);
  const ruleId = token(finding.rule_id || finding.ruleId);
  for (const issue of CANONICAL_ISSUES) {
    if (issue.topics.includes(topic) || issue.rulePrefixes.some((prefix) => ruleId.startsWith(prefix))) return issue.id;
  }
  return "";
}

function eventScope(finding = {}) {
  const event = finding.breach_event || finding.event_id || finding.event || "";
  const subject = finding.subject || finding.subject_party || finding.object_party || "";
  return [token(event), token(subject)].filter(Boolean).join("|");
}

function canonicalAggregationKey(finding = {}) {
  const canonical = canonicalIssueId(finding);
  if (!canonical) return "";
  const location = finding.contract_location || {};
  const version = location.file_version_id || finding.file_version_id || "";
  const scope = eventScope(finding);
  return `${version}|canonical:${canonical}${scope ? `|event:${scope}` : ""}`;
}

module.exports = { CANONICAL_ISSUES, canonicalIssueId, canonicalAggregationKey, eventScope };
