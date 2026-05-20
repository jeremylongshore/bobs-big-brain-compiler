# Security Policy

## Supported Versions

| Version  | Supported   |
| -------- | ----------- |
| latest   | Yes         |
| < latest | Best effort |

## Reporting a Vulnerability

**Please do NOT open public issues for security concerns.**

Email **security@jeremylongshore.com** with:

- Type of issue (e.g., buffer overflow, injection, privilege escalation)
- Full paths of related source files
- Location of the affected code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce
- Step-by-step instructions to reproduce
- Proof-of-concept or exploit code (if possible)
- Impact assessment

### Response Timeline

| Stage              | Timeframe           |
| ------------------ | ------------------- |
| Acknowledgment     | 24 hours            |
| Initial assessment | 48 hours            |
| Status update      | 5 business days     |
| Resolution         | Depends on severity |

### Severity Levels

| Severity | CVSS     | Examples                                | Target Resolution |
| -------- | -------- | --------------------------------------- | ----------------- |
| Critical | 9.0-10.0 | Remote code execution, credential theft | 24 hours          |
| High     | 7.0-8.9  | Privilege escalation, data exposure     | 7 days            |
| Medium   | 4.0-6.9  | Cross-site scripting, denial of service | 30 days           |
| Low      | 0.1-3.9  | Information disclosure, minor issues    | 90 days           |

## Disclosure Process

1. **Report** — You email the details to security@jeremylongshore.com
2. **Triage** — We assess severity and impact
3. **Fix** — We develop and test a patch
4. **Notify** — We inform affected users
5. **Release** — We publish the fix
6. **Post-Mortem** — We document lessons learned

## Security Best Practices

When contributing to this project:

- Never hardcode credentials or secrets
- Validate all input at system boundaries
- Keep dependencies up to date
- Use HTTPS for all external communication
- Follow the principle of least privilege
- Do not log sensitive information
- Write tests for security-critical paths

## Recognition

We appreciate responsible disclosure. Reporters who follow this policy will receive:

- Credit in security advisories (unless anonymity is preferred)
- Mention in CONTRIBUTORS.md
- Our sincere gratitude

## Contact

- **Security reports**: security@jeremylongshore.com
- **General inquiries**: jeremy@jeremylongshore.com
- **Response time**: 24 hours for initial acknowledgment
