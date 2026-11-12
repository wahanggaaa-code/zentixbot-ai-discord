// Intentionally fail closed: the previous implementation could drop or overwrite
// the wrong database and exposed connection URLs. Restore needs a separately
// reviewed, verified target-selection and recovery workflow.
console.error('Restore is temporarily disabled pending a safe target-selection and recovery workflow. No database was changed.');
process.exitCode=1;
