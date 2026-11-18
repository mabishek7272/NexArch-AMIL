/**
 * Local AIKosh benchmark runner (offline; no model, no network, no approval needed). Prints a descriptive report; computes no clinical score.
 *   npx tsx scripts/aikosh-eval.ts <calculator|medmcqa|pharmacology_mcq|drug_brand|lab|kg_s|kg_m|pathology|protocols> [--split dev|test --final] [--predictor baseline]
 * test is scored only with --final (each look is counted in the report).
 */
import * as bench from '../src/aikosh/bench';

const argv = process.argv.slice(2); const name = argv[0]; const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
(async () => {
  const split = (opt('split') ?? 'dev') as 'dev' | 'test'; const final = argv.includes('--final'); let report: unknown;
  switch (name) {
    case 'calculator': report = bench.runBenchmark(await bench.calculatorBench(), bench.trainMedian(), split, { final }); break;
    case 'medmcqa': report = bench.runBenchmark(await bench.medmcqaBench(), bench.majorityLetter(), split, { final }); break;
    case 'pharmacology_mcq': report = bench.runBenchmark(await bench.pharmacologyBench(), bench.majorityLetter(), split, { final }); break;
    case 'drug_brand': report = bench.runBenchmark(await bench.drugBrandBench(), bench.majorityLetter(), split, { final }); break;
    case 'lab': report = bench.runBenchmark(await bench.labBench(), bench.labLookup(), split, { final }); break;
    case 'kg_s': { const b = await bench.kgBench('knowledge_graph/bodhi_s_nl_facts.jsonl'); report = { ...bench.runBenchmark(b, bench.bm25(b.corpus), split, { final }), unparsedFacts: b.unparsed }; break; }
    case 'kg_m': { const b = await bench.kgBench('knowledge_graph/bodhi_m_nl_facts.jsonl'); report = { ...bench.runBenchmark(b, bench.bm25(b.corpus), split, { final }), unparsedFacts: b.unparsed }; break; }
    case 'pathology': { const b = await bench.pathologyBench(); report = { ...bench.runBenchmark(b, bench.regexExtractor(), split, { final }), fieldAccuracy: bench.fieldAccuracy(b, bench.regexExtractor(), split), sampleCoverage: await bench.sampleCoverage() }; break; }
    case 'protocols': report = await bench.protocolsQnaSummary(); break;
    default: console.error('usage: aikosh-eval <calculator|medmcqa|pharmacology_mcq|drug_brand|lab|kg_s|kg_m|pathology|protocols> [--split dev|test --final]'); process.exit(2);
  }
  console.log(JSON.stringify(report, null, 1));
})().catch((e) => { console.error(`${(e as Error).name}: ${(e as Error).message}`); process.exit(2); });
