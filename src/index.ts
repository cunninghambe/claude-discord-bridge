import 'dotenv/config';

async function main(): Promise<void> {
  // Wiring is added in subsequent commits. This stub exists so the scaffold
  // builds and runs end-to-end.
  console.log('claude-discord-bridge: scaffold OK');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
