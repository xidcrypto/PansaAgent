# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

**DO NOT** create a public GitHub issue for security vulnerabilities.

### How to Report

Send an email to: **security@xidcrypto.dev** (or use GitHub Security Advisories)

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### What to Expect

- **Within 48 hours**: Acknowledgment of your report
- **Within 7 days**: Initial assessment and timeline
- **Within 30 days**: Fix released (for critical issues)

### Scope

Report security issues related to:
- Private key / mnemonic handling
- Keystore encryption
- Transaction signing
- Gateway authentication
- Secret storage
- Policy enforcement

**Out of scope**:
- Dependency vulnerabilities (report to upstream)
- Issues requiring physical access
- Social engineering attacks

## Security Best Practices

1. **Never share your mnemonic or private keys**
2. **Always verify transaction details before confirming**
3. **Use testnet for experimentation**
4. **Enable spending limits in config**
5. **Keep your `~/.pansa/` directory secure**
6. **Use a strong passphrase for keystore**
7. **Review gateway allowlist regularly**

## Bug Bounty

We do not currently offer a bug bounty program. However, we greatly appreciate responsible disclosure and will acknowledge contributors in our security advisories (with permission).
