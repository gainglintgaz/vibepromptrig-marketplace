# Caring for customer information and money

Audience: any project that handles customer details or money, including a small business or physical-product service. Useful when this is uncertain; it does not assume a finance app or require a database.

This reference guides decisions. It does not install protection, connect to a service, establish legal compliance or grant permission to change records.

- Identify what information is actually needed and why. Collect less; avoid copying names, addresses, health details, identity documents or account numbers into prompts, public examples or logs.
- Ask who may see each record. A project built by one person can still serve many customers with separate private records. Enforce access in the service storing the data; hiding a screen is insufficient.
- Keep passwords, access keys and payment secrets in the service's supported secret storage. Never paste them into chat or put them in browser-delivered code. Use the least access needed and a development or test environment while building.
- Use the payment provider's hosted collection flow when available. Do not store card numbers or security codes yourself. Explain price, currency, taxes and refund terms before a customer agrees; preserve an auditable payment and refund record.
- Check amounts and record ownership against their original source. Never invent missing amounts, customer details, consent or a successful payment. Mark uncertain information clearly and keep consequential actions pending.
- Ask before sending confidential designs or customer information to another service. Explain which details, destination and purpose are involved. Choosing guidance here does not authorize an upload.
- Plan how customers correct, export or delete their information. Define retention and necessary business records with an appropriate specialist; avoid claiming that a generic checklist satisfies every jurisdiction.
- Before a consequential data change, show the exact scope, get appropriate authority, keep a recoverable backup and verify the result. Restore only what the reviewed change owned; preserve later edits.

First-use check: with fabricated test records, confirm that one customer's account cannot read or change another's information, rejected requests create no side effects, private details stay out of logs, and a test payment/refund is traceable. Automated software checks do not certify the safety of a manufactured product.

Keep unavailable checks and unknown obligations visible. Ask a qualified specialist about the specific product, jurisdiction and risk when needed.
