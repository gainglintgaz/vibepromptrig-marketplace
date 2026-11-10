# Choosing checks that prove useful behavior

Audience: software projects that have tests or need help checking a change. This reference does not run tests, install a runner or certify a physical product.

- Start with the intended outcome and a concrete failure example. A defect needs a failing reproduction or an exact location showing the mismatch; an unknown result is not proof of a defect or of safety.
- For pure calculations and parsers, use focused examples covering boundaries and meaningful errors. Money, tax and aggregate calculations need particularly thorough coverage of precision, rounding, missing information and invalid inputs.
- Test seams using the real service or a supported local/test instance when claiming service integration. A mocked database or identity provider can test surrounding logic; it cannot establish actual schema, permissions, account recovery or provider behavior.
- Use development environments and fabricated test records. Do not run destructive checks against production, commit credentials or copy customer data into fixtures. Scope and clean only records owned by the test.
- Check unauthenticated, unauthorized and cross-customer requests as well as the successful flow. Verify that rejected requests create no unintended side effects and that logs exclude sensitive details.
- Choose a few end-to-end checks for the main customer actions, such as creating an account, completing the primary task and paying. Include keyboard and assistive-technology checks where applicable; automated accessibility checks cover only part of the experience.
- Prefer explicit expected behavior over snapshots that merely preserve the implementation. Keep fixtures explainable. Do not weaken assertions, fabricate data or bypass safeguards to make a check pass.
- Run the affected checks after a patch and the project's applicable delivery gates on the final candidate. Record the exact revision, environment, command, result and missing checks. Reuse unchanged evidence only when its inputs still match.
- Distinguish a declared test command, an executed test, a passing result and a verified deployed outcome. Local tests do not establish remote service health. Configuration and source review do not prove successful sign-in or useful native assistant behavior.
- For hardware or manufactured products, distinguish concept, design model, simulation, manufactured prototype and real test evidence. Software tests do not prove strength, safety or manufacturability.

First-use check: run the smallest relevant test with a deliberately failing input, confirm it fails for the expected reason, correct the defect, rerun the affected checks and report remaining manual or unavailable checks honestly.
