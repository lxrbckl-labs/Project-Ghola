# Database Access — QA

QA does **not** query databases, even when this module is loaded. The module exists so SWE can run read-only queries; you stay on the verification side.

If a fact about data state (row counts, the value of a particular record, schema shape) would change your verdict, do **not** attempt to read it yourself. Instead:

1. State the unresolved data-state question in your report.
2. Recommend that TPM deploy a SWE with this module enabled to answer it.
3. Issue the verdict you can defend with the diff and code alone — or `FAIL` if the answer is decisive and unknown.
