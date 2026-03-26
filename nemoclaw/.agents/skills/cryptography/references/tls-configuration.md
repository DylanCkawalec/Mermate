# TLS Configuration Guide

This reference provides TLS/SSL configuration guidance for various platforms and use cases.

## TLS Version Requirements

| Version | Status | Notes |
|---------|--------|-------|
| TLS 1.3 | ✅ Required | Best security, 0-RTT, smaller handshake |
| TLS 1.2 | ✅ Acceptable | Secure with proper cipher configuration |
| TLS 1.1 | ❌ Deprecated | EOL March 2020 |
| TLS 1.0 | ❌ Deprecated | EOL March 2020, BEAST attack |
| SSL 3.0 | ❌ Broken | POODLE attack |
| SSL 2.0 | ❌ Broken | Multiple vulnerabilities |

## Cipher Suite Selection

### TLS 1.3 Cipher Suites

TLS 1.3 only supports AEAD ciphers:

```text
TLS_AES_256_GCM_SHA384        # AES-256 with GCM
TLS_CHACHA20_POLY1305_SHA256  # ChaCha20-Poly1305
TLS_AES_128_GCM_SHA256        # AES-128 with GCM
```

### TLS 1.2 Recommended Cipher Suites

```text
# Ordered by preference
ECDHE-ECDSA-AES256-GCM-SHA384
ECDHE-RSA-AES256-GCM-SHA384
ECDHE-ECDSA-CHACHA20-POLY1305
ECDHE-RSA-CHACHA20-POLY1305
ECDHE-ECDSA-AES128-GCM-SHA256
ECDHE-RSA-AES128-GCM-SHA256
```

**Requirements:**

- ECDHE for forward secrecy
- AEAD modes (GCM or Poly1305)
- No CBC mode (BEAST, Lucky 13)
- No RC4, 3DES, or export ciphers

## Platform-Specific Configuration

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name example.com;

    # Certificate files
    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    # Protocol versions
    ssl_protocols TLSv1.2 TLSv1.3;

    # Cipher suites
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    # DH parameters (generate with: openssl dhparam -out dhparam.pem 2048)
    ssl_dhparam /etc/nginx/dhparam.pem;

    # ECDH curve
    ssl_ecdh_curve X25519:secp384r1;

    # Session caching
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:50m;
    ssl_session_tickets off;

    # OCSP Stapling
    ssl_stapling on;
    ssl_stapling_verify on;
    ssl_trusted_certificate /etc/letsencrypt/live/example.com/chain.pem;
    resolver 8.8.8.8 8.8.4.4 valid=300s;
    resolver_timeout 5s;

    # Security headers
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
}
```

### Apache

```apache
<VirtualHost *:443>
    ServerName example.com

    # Certificate files
    SSLCertificateFile /etc/letsencrypt/live/example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/example.com/privkey.pem

    # Protocol versions
    SSLProtocol -all +TLSv1.2 +TLSv1.3

    # Cipher suites
    SSLCipherSuite ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305
    SSLHonorCipherOrder off

    # OCSP Stapling
    SSLUseStapling on
    SSLStaplingCache "shmcb:logs/ssl_stapling(32768)"

    # HSTS
    Header always set Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
</VirtualHost>
```

### HAProxy

```haproxy
global
    ssl-default-bind-ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305
    ssl-default-bind-ciphersuites TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256
    ssl-default-bind-options ssl-min-ver TLSv1.2 no-tls-tickets

frontend https
    bind *:443 ssl crt /etc/haproxy/certs/ alpn h2,http/1.1
    http-response set-header Strict-Transport-Security max-age=63072000
```

### AWS Application Load Balancer

```yaml
# CloudFormation
LoadBalancer:
  Type: AWS::ElasticLoadBalancingV2::LoadBalancer
  Properties:
    SecurityPolicy: ELBSecurityPolicy-TLS13-1-2-2021-06
    # Or for TLS 1.2 minimum:
    # SecurityPolicy: ELBSecurityPolicy-TLS-1-2-2017-01
```

### .NET/Kestrel

```csharp
// Program.cs
builder.WebHost.ConfigureKestrel(options =>
{
    options.ConfigureHttpsDefaults(https =>
    {
        https.SslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13;
    });
});

// Or in appsettings.json
{
  "Kestrel": {
    "Endpoints": {
      "Https": {
        "Url": "https://*:443",
        "Certificate": {
          "Path": "/certs/cert.pfx",
          "Password": "certpassword"
        },
        "SslProtocols": ["Tls12", "Tls13"]
      }
    }
  }
}
```

### Node.js

```javascript
const https = require('https');
const fs = require('fs');

const options = {
    key: fs.readFileSync('privkey.pem'),
    cert: fs.readFileSync('fullchain.pem'),
    minVersion: 'TLSv1.2',
    ciphers: [
        'ECDHE-ECDSA-AES128-GCM-SHA256',
        'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-ECDSA-CHACHA20-POLY1305',
        'ECDHE-RSA-CHACHA20-POLY1305'
    ].join(':'),
    honorCipherOrder: false
};

https.createServer(options, app).listen(443);
```

### ASP.NET Core (Minimal API)

```csharp
// Program.cs - TLS configuration with custom cipher suites
using System.Net.Security;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel(options =>
{
    options.ListenAnyIP(443, listenOptions =>
    {
        listenOptions.UseHttps(httpsOptions =>
        {
            httpsOptions.ServerCertificate = X509Certificate2.CreateFromPemFile(
                "/certs/fullchain.pem", "/certs/privkey.pem");

            httpsOptions.SslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13;

            httpsOptions.OnAuthenticate = (context, sslOptions) =>
            {
                // TLS 1.3 cipher suites are automatic
                // For TLS 1.2, configure via CipherSuitesPolicy (Linux only)
#if !WINDOWS
                sslOptions.CipherSuitesPolicy = new CipherSuitesPolicy([
                    TlsCipherSuite.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
                    TlsCipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
                    TlsCipherSuite.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
                    TlsCipherSuite.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
                    TlsCipherSuite.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
                    TlsCipherSuite.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
                ]);
#endif
            };
        });
    });
});

var app = builder.Build();
app.Run();
```

## Security Headers

### HTTP Strict Transport Security (HSTS)

Forces browsers to only connect via HTTPS:

```text
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
```

| Directive | Purpose |
|-----------|---------|
| max-age | How long browser remembers to use HTTPS (seconds) |
| includeSubDomains | Apply to all subdomains |
| preload | Allow inclusion in browser preload lists |

**Warning:** Test thoroughly before enabling. Mistakes can lock users out.

### Content Security Policy (CSP)

Prevents XSS and data injection:

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://api.example.com; frame-ancestors 'none'
```

### Other Security Headers

```nginx
# Prevent MIME type sniffing
add_header X-Content-Type-Options nosniff always;

# Clickjacking protection
add_header X-Frame-Options DENY always;

# XSS filter (legacy browsers)
add_header X-XSS-Protection "1; mode=block" always;

# Referrer policy
add_header Referrer-Policy "strict-origin-when-cross-origin" always;

# Permissions policy (disable sensitive APIs)
add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;
```

## Certificate Management

### Certificate Requirements

- RSA 2048+ bits or ECDSA P-256+
- SHA-256 or stronger signature
- Valid chain to trusted root
- SANs (Subject Alternative Names) for all domains
- Not expired or revoked

### Let's Encrypt with Certbot

```bash
# Install
apt install certbot python3-certbot-nginx

# Obtain certificate
certbot --nginx -d example.com -d www.example.com

# Auto-renewal (usually set up automatically)
certbot renew --dry-run

# Cron for renewal
0 0 1 * * /usr/bin/certbot renew --quiet
```

### OCSP Stapling

OCSP stapling improves performance and privacy by having the server fetch OCSP responses:

```nginx
ssl_stapling on;
ssl_stapling_verify on;
ssl_trusted_certificate /path/to/chain.pem;
```

## Testing TLS Configuration

### Online Tools

- **SSL Labs**: <https://www.ssllabs.com/ssltest/>
- **Hardenize**: <https://www.hardenize.com/>
- **Security Headers**: <https://securityheaders.com/>

### Command Line

```bash
# Test TLS versions
openssl s_client -connect example.com:443 -tls1_2
openssl s_client -connect example.com:443 -tls1_3

# Show certificate
openssl s_client -connect example.com:443 -showcerts

# Check certificate expiry
echo | openssl s_client -connect example.com:443 2>/dev/null | openssl x509 -noout -dates

# Test specific cipher
openssl s_client -connect example.com:443 -cipher ECDHE-RSA-AES128-GCM-SHA256

# Enumerate ciphers (with nmap)
nmap --script ssl-enum-ciphers -p 443 example.com
```

## Common Issues

### Mixed Content

HTTPS pages loading HTTP resources will be blocked:

```html
<!-- WRONG -->
<script src="http://example.com/script.js"></script>

<!-- RIGHT -->
<script src="https://example.com/script.js"></script>
<!-- Or protocol-relative (not recommended) -->
<script src="//example.com/script.js"></script>
```

### Certificate Chain Issues

Ensure full chain is provided:

```bash
# Check chain
openssl s_client -connect example.com:443 -showcerts

# Verify chain
openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt chain.pem
```

### HSTS Preload Issues

Before enabling preload:

1. Ensure all subdomains support HTTPS
2. Test with short max-age first
3. Check at <https://hstspreload.org/>

## Security Checklist

- [ ] TLS 1.2 minimum, TLS 1.3 preferred
- [ ] Strong cipher suites only (AEAD)
- [ ] Perfect forward secrecy (ECDHE)
- [ ] Valid certificate from trusted CA
- [ ] Full certificate chain provided
- [ ] OCSP stapling enabled
- [ ] HSTS header set (after testing)
- [ ] Security headers configured
- [ ] No mixed content
- [ ] Regular certificate renewal
- [ ] SSL Labs grade A or A+
