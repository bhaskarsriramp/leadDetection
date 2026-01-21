import { zeroShotBatchFilter, getFilterStats } from './zeroShot.js';
import {
  analyzeLeadIntent,
  getIntentStats,
  getQualifiedLeads,
} from './geminiIntentAnalyser.js';

/**
 * Complete 2-stage pipeline for lead qualification
 * Stage 1: HuggingFace BART zero-shot classification (filter noise)
 * Stage 2: Gemini lead intent analysis (qualify leads)
 */
export async function processLeadPipeline(messages) {
  console.log('\n========================================');
  console.log('LEAD QUALIFICATION PIPELINE - STARTED');
  console.log(`Total messages: ${messages.length}`);
  console.log('========================================\n');

  try {
    // ============================================
    // STAGE 1: HuggingFace Filter
    // ============================================
    console.log('🔍 STAGE 1: Filtering with HuggingFace BART...\n');

    const stage1Results = await zeroShotBatchFilter(messages);
    const stage1Stats = getFilterStats(stage1Results);

    console.log('\n📊 STAGE 1 RESULTS:');
    console.log(`  Total messages: ${stage1Stats.total}`);
    console.log(`  Passed to Stage 2: ${stage1Stats.passed} (${stage1Stats.passRate})`);
    console.log(`  Filtered out: ${stage1Stats.filtered} (${stage1Stats.filterRate})`);
    console.log('  Label distribution:', stage1Stats.labelDistribution);

    // Filter messages that passed Stage 1
    const passedToStage2 = stage1Results.filter((r) => r.PASS_CONV);

    if (passedToStage2.length === 0) {
      console.log('\n⚠️  No messages passed Stage 1 filter. Pipeline complete.');
      return {
        stage1: stage1Results,
        stage2: [],
        qualifiedLeads: [],
        summary: {
          totalMessages: messages.length,
          stage1Filtered: stage1Stats.filtered,
          stage2Analyzed: 0,
          qualifiedLeads: 0,
          overallConversionRate: '0.0%',
        },
      };
    }

    // ============================================
    // STAGE 2: Gemini Intent Analysis
    // ============================================
    console.log('\n\n🤖 STAGE 2: Analyzing lead intent with Gemini...\n');

    const stage2Results = await analyzeLeadIntent(passedToStage2);
    const stage2Stats = getIntentStats(stage2Results);

    console.log('\n📊 STAGE 2 RESULTS:');
    console.log(`  Total analyzed: ${stage2Stats.total}`);
    console.log(`  Qualified leads: ${stage2Stats.qualified} (${stage2Stats.qualificationRate})`);
    console.log(`  Average intent score: ${stage2Stats.avgIntent}`);
    console.log('  Intent distribution:', stage2Stats.intentDistribution);

    // Get qualified leads sorted by intent score
    const qualifiedLeads = getQualifiedLeads(stage2Results);

    // ============================================
    // FINAL SUMMARY
    // ============================================
    const overallConversionRate =
      ((qualifiedLeads.length / messages.length) * 100).toFixed(1) + '%';

    console.log('\n========================================');
    console.log('✅ PIPELINE COMPLETE - SUMMARY');
    console.log('========================================');
    console.log(`Total messages processed: ${messages.length}`);
    console.log(`Stage 1 filtered: ${stage1Stats.filtered}`);
    console.log(`Stage 2 analyzed: ${stage2Stats.total}`);
    console.log(`Qualified leads: ${qualifiedLeads.length}`);
    console.log(`Overall conversion rate: ${overallConversionRate}`);
    console.log('========================================\n');

    // Return comprehensive results
    return {
      stage1: stage1Results,
      stage2: stage2Results,
      qualifiedLeads,
      summary: {
        totalMessages: messages.length,
        stage1Filtered: stage1Stats.filtered,
        stage1Passed: stage1Stats.passed,
        stage2Analyzed: stage2Stats.total,
        qualifiedLeads: qualifiedLeads.length,
        avgIntentScore: stage2Stats.avgIntent,
        overallConversionRate,
        stage1Stats: stage1Stats,
        stage2Stats: stage2Stats,
      },
    };
  } catch (error) {
    console.error('\n❌ PIPELINE FAILED:', error);
    throw error;
  }
}

/**
 * Export qualified leads to various formats
 */
export function exportQualifiedLeads(qualifiedLeads, format = 'json') {
  if (format === 'json') {
    return JSON.stringify(qualifiedLeads, null, 2);
  }

  if (format === 'csv') {
    const headers = 'Message ID,Lead Intent,Reasoning,Message Preview\n';
    const rows = qualifiedLeads
      .map((lead) => {
        const preview = lead.message.substring(0, 50).replace(/"/g, '""');
        return `"${lead.messageId}",${lead.lead_intent},"${lead.reasoning}","${preview}..."`;
      })
      .join('\n');
    return headers + rows;
  }

  if (format === 'summary') {
    return qualifiedLeads
      .map(
        (lead, idx) =>
          `${idx + 1}. [${lead.messageId}] (Intent: ${lead.lead_intent})\n` +
          `   Message: ${lead.message.substring(0, 100)}...\n` +
          `   Reasoning: ${lead.reasoning}\n`
      )
      .join('\n');
  }

  return qualifiedLeads;
}
