// Intentionally fail closed: the previous drill automatically created and
// dropped a database while passing connection URLs to child processes.
console.error('Restore drill is temporarily disabled pending a safe disposable-target workflow. No database was changed.');
process.exitCode=1;
