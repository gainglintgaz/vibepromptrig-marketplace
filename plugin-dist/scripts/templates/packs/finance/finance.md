# Guidance for finance and bookkeeping software

Audience: projects explicitly building finance, accounting, tax or bookkeeping features. General uncertainty about money or personal information alone is not evidence that this specialized reference fits.

This reference is guidance, not an automated safeguard, legal opinion or permission to alter financial records. Adapt the details to the product and have a qualified specialist review regulated calculations and filings.

- Store currency as integer minor units or an exact decimal with an explicit currency and scale. Do not use binary floating point for money. Use deterministic rounding and check overflow, negative values, allocation and exchange-rate dates.
- Give every displayed amount a trail to source records, dates, calculations and adjustments. Distinguish source dates from upload dates. Show currency and the applicable accounting or tax period.
- Keep imported, manually entered, estimated and independently verified information distinguishable. Missing or conflicting information produces an honest unavailable result or disclosed range; it must not produce a fabricated balance or confident projection.
- Verify jurisdiction, year, filing status and the actual source of any tax or regulatory rule. Record source date and version. Do not copy an old threshold or claim current compliance without checking it for this product.
- Keep personal, business and customer records isolated as intended. Enforce owner access where records are read and changed; clear old account data on account or mode changes. Test unauthorized access and cross-customer attempts.
- Keep account numbers, identity documents and full customer details out of AI requests and logs unless the exact processing is authorized and appropriate. Use supported secret storage and make provider calls from a trusted service.
- Use a development database for destructive tests and migrations. Show exact affected data before a production action; retain backups, test restoration and preserve an audit trail. Access limited to reading can still expose private data.
- If AI explains an amount, record the actual source references and the prompt/version needed to investigate it. Check its claims against those sources. A model's confidence is not verification.
- Provide clear disclosures for projections and advice; support correction, data export and appropriate deletion/retention. Regulatory obligations depend on the product and jurisdiction. Do not infer legal readiness from this document.
- Treat automatic trading, tax filing, investment, insurance and international-tax advice as separate scoped capabilities requiring specialist review. A bookkeeping feature does not authorize those actions.

First-use check: reconcile a known test statement end to end, inspect the source trail for a displayed amount, test rounding and sparse/conflicting data, reject a second customer's access, and perform a restoration drill in the development environment. A successful local test is evidence only for the checked inputs and environment.
