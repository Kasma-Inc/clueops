import { InvestigationStore } from '../../src/core/store.ts';
const [directory, phase, data] = process.argv.slice(2);
try {
  const store = await InvestigationStore.open(directory, {
    commitProbe: async (step) => {
      if (step === phase) {
        process.stdout.write(step + '\n');
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      }
    },
  });
  if (data) await store.accept(JSON.parse(Buffer.from(data, 'base64').toString()));
  await store.close();
  process.stdout.write('closed\n');
} catch (error) {
  process.stdout.write(String(error.code ?? 'FAILED') + '\n');
  process.exitCode = 1;
}
