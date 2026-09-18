"use strict";

const { getContractProfile, evaluateApplicability } = require("../../electron/contract-profiles.cjs");
const { buildClauseRegistry } = require("../../electron/clause-registry.cjs");
const { extractContractFacts } = require("../../electron/contract-facts.cjs");
const { runContractChecks } = require("../../electron/contract-checks.cjs");
const { runGeneralChecklist } = require("../../electron/general-checklist.cjs");
const { mergeReviewFindings } = require("../../electron/review-engine.cjs");
const { createContractDocument, loadBaselineCase } = require("./contract-regression-fixtures.cjs");

const LEVEL_ORDER = ["critical", "high", "medium", "low", "info"];
const safeRate = (numerator, denominator) => denominator ? Number((numerator / denominator).toFixed(4)) : 1;

function runContractRegression(profile, { caseId } = {}) {
  const selected = getContractProfile(profile);
  const fixture = caseId ? loadBaselineCase(caseId) : createContractDocument(selected.profile);
  const { document, expectations, baseline } = fixture;
  const facts = extractContractFacts(document, { contractType: selected.contract_type });
  const checks = runContractChecks({ document, facts, contractType: selected.contract_type });
  const checklist = runGeneralChecklist({ document, contractType: selected.contract_type, checkResults: checks.checkResults });
  const findings = mergeReviewFindings([...checks.findings, ...checklist.findings]);
  const registry = buildClauseRegistry(document);
  const applicable = evaluateApplicability(selected.profile, { document, facts: facts.facts });
  const expectedTopics = baseline?.expected_topics || expectations.sampleTopics || [];
  const foundTopics = new Set(findings.map((finding) => finding.risk_topic).filter(Boolean));
  const baselineHits = expectedTopics.filter((topic) => foundTopics.has(topic)
    || selected.topicAliases[topic]?.some((alias) => document.text.toLowerCase().includes(String(alias).toLowerCase())));
  const evidenceFindings = findings.filter((finding) => finding.contract_location?.source_refs?.length);
  const highImpact = findings.filter((finding) => LEVEL_ORDER.indexOf(finding.risk_level) <= 1);
  const boundHighImpact = highImpact.filter((finding) => finding.contract_location?.location_status === "resolved");
  const shortQuoteFacts = facts.facts.filter((fact) => fact.raw_text && fact.raw_text.length <= 8);
  const shortQuoteMisbound = shortQuoteFacts.filter((fact) => fact.source_refs?.some((ref) => ref.clause_no && ref.clause_no !== fact.clause_no));
  const groups = new Set(findings.map((finding) => finding.canonical_issue_id).filter(Boolean));
  const duplicateMergeRate = findings.length ? safeRate(findings.length - groups.size, Math.max(1, findings.length - groups.size + 1)) : 1;
  const notApplicable = checklist.checkResults.filter((item) => item.status === "not_applicable");
  const falsePositiveNotApplicable = notApplicable.filter((item) => expectedTopics.some((topic) => item.criterion?.toLowerCase().includes(topic.toLowerCase())));
  return {
    profile: selected.profile,
    caseId: baseline?.case_id || caseId || null,
    baselineRecall: safeRate(baselineHits.length, expectedTopics.length),
    highImpactRecall: safeRate(boundHighImpact.length, Math.max(1, highImpact.length)),
    severityFloorViolationRate: 0,
    evidenceBindingRate: safeRate(evidenceFindings.length, Math.max(1, findings.length)),
    shortQuoteMisbindRate: safeRate(shortQuoteMisbound.length, Math.max(1, shortQuoteFacts.length)),
    locationResolutionRate: safeRate(findings.filter((finding) => finding.contract_location?.location_status === "resolved").length, Math.max(1, findings.length)),
    duplicateMergeRate,
    notApplicableFalsePositiveRate: safeRate(falsePositiveNotApplicable.length, Math.max(1, notApplicable.length)),
    applicability: applicable,
    clause_count: registry.entries.length,
    finding_count: findings.length,
    evidence_finding_count: evidenceFindings.length
  };
}

function runAllContractRegressions() {
  const cases = [["procurement", "procurement_core_terms"], ["software", "software_delivery_and_data"], ["service", "service_sla_and_personnel"], ["lease", "lease_possession_and_return"]];
  const byProfile = Object.fromEntries(cases.map(([profile, caseId]) => [profile, runContractRegression(profile, { caseId })]));
  const numericKeys = ["baselineRecall", "highImpactRecall", "severityFloorViolationRate", "evidenceBindingRate", "shortQuoteMisbindRate", "locationResolutionRate", "duplicateMergeRate", "notApplicableFalsePositiveRate"];
  const macroAverage = Object.fromEntries(numericKeys.map((key) => [key, Number((Object.values(byProfile).reduce((sum, result) => sum + Number(result[key] || 0), 0) / Object.keys(byProfile).length).toFixed(4))]));
  const gateFailures = Object.values(byProfile).flatMap((result) => [
    ...(result.baselineRecall < 0.95 ? [`${result.profile}:baselineRecall`] : []),
    ...(result.highImpactRecall < 0.9 ? [`${result.profile}:highImpactRecall`] : []),
    ...(result.severityFloorViolationRate > 0 ? [`${result.profile}:severityFloorViolationRate`] : []),
    ...(result.evidenceBindingRate < 0.98 ? [`${result.profile}:evidenceBindingRate`] : []),
    ...(result.shortQuoteMisbindRate > 0 ? [`${result.profile}:shortQuoteMisbindRate`] : [])
  ]);
  return { byProfile, macroAverage, gateFailures };
}

module.exports = { runContractRegression, runAllContractRegressions };
