# Algorithm Selection Guide

This reference provides detailed guidance for selecting cryptographic algorithms.

## Symmetric Encryption

### AES (Advanced Encryption Standard)

The gold standard for symmetric encryption. Use AES-256 for maximum security.

#### Mode Comparison

| Mode | Authentication | Parallelizable | Use Case |
|------|----------------|----------------|----------|
| GCM | ✅ Built-in | ✅ Yes | **Recommended** - most use cases |
| CCM | ✅ Built-in | ❌ No | Constrained environments |
| CTR | ❌ No | ✅ Yes | Only with separate MAC |
| CBC | ❌ No | ❌ No | Legacy only |
| ECB | ❌ No | ✅ Yes | **Never use** - patterns visible |

#### AES-GCM Implementation

```csharp
using System.Security.Cryptography;

/// <summary>
/// AES-256-GCM encryption with authenticated additional data support.
/// </summary>
public sealed class AesGcmEncryption : IDisposable
{
    private const int NonceSize = 12;  // 96-bit nonce is optimal for GCM
    private const int TagSize = 16;    // 128-bit authentication tag
    private readonly byte[] _key;

    public AesGcmEncryption(byte[]? key = null)
    {
        _key = key ?? RandomNumberGenerator.GetBytes(32); // 256-bit key
    }

    /// <summary>
    /// Encrypt with random nonce, returns nonce + ciphertext + tag.
    /// </summary>
    public byte[] Encrypt(ReadOnlySpan<byte> plaintext, ReadOnlySpan<byte> associatedData = default)
    {
        var nonce = RandomNumberGenerator.GetBytes(NonceSize);
        var ciphertext = new byte[plaintext.Length];
        var tag = new byte[TagSize];

        using var aesGcm = new AesGcm(_key, TagSize);
        aesGcm.Encrypt(nonce, plaintext, ciphertext, tag, associatedData);

        // Return nonce + ciphertext + tag
        var result = new byte[NonceSize + ciphertext.Length + TagSize];
        nonce.CopyTo(result, 0);
        ciphertext.CopyTo(result, NonceSize);
        tag.CopyTo(result, NonceSize + ciphertext.Length);

        return result;
    }

    /// <summary>
    /// Decrypt nonce + ciphertext + tag.
    /// </summary>
    public byte[] Decrypt(ReadOnlySpan<byte> data, ReadOnlySpan<byte> associatedData = default)
    {
        var nonce = data[..NonceSize];
        var ciphertext = data[NonceSize..^TagSize];
        var tag = data[^TagSize..];
        var plaintext = new byte[ciphertext.Length];

        using var aesGcm = new AesGcm(_key, TagSize);
        aesGcm.Decrypt(nonce, ciphertext, tag, plaintext, associatedData);

        return plaintext;
    }

    public void Dispose() => CryptographicOperations.ZeroMemory(_key);
}
```

### ChaCha20-Poly1305

Alternative to AES, excellent for software implementations without hardware acceleration.

```csharp
using System.Security.Cryptography;

/// <summary>
/// Encrypt with ChaCha20-Poly1305.
/// </summary>
public static byte[] EncryptChaCha(
    ReadOnlySpan<byte> key,
    ReadOnlySpan<byte> plaintext,
    ReadOnlySpan<byte> associatedData = default)
{
    const int nonceSize = 12;
    const int tagSize = 16;

    var nonce = RandomNumberGenerator.GetBytes(nonceSize);
    var ciphertext = new byte[plaintext.Length];
    var tag = new byte[tagSize];

    using var chacha = new ChaCha20Poly1305(key);
    chacha.Encrypt(nonce, plaintext, ciphertext, tag, associatedData);

    // Return nonce + ciphertext + tag
    var result = new byte[nonceSize + ciphertext.Length + tagSize];
    nonce.CopyTo(result, 0);
    ciphertext.CopyTo(result, nonceSize);
    tag.CopyTo(result, nonceSize + ciphertext.Length);

    return result;
}
```

**When to choose ChaCha20 over AES:**

- Mobile devices without AES-NI
- Software-only environments
- Side-channel attack concerns
- Need constant-time implementation

## Asymmetric Encryption

### RSA

```csharp
using System.Security.Cryptography;

/// <summary>
/// RSA encryption utilities with OAEP padding (recommended).
/// </summary>
public static class RsaEncryption
{
    /// <summary>
    /// Generate RSA key pair.
    /// </summary>
    public static RSA GenerateKeyPair(int keySize = 2048)
    {
        return RSA.Create(keySize);
    }

    /// <summary>
    /// Encrypt with RSA-OAEP (recommended padding).
    /// </summary>
    public static byte[] Encrypt(RSA publicKey, byte[] plaintext)
    {
        return publicKey.Encrypt(plaintext, RSAEncryptionPadding.OaepSHA256);
    }

    /// <summary>
    /// Decrypt with RSA-OAEP.
    /// </summary>
    public static byte[] Decrypt(RSA privateKey, byte[] ciphertext)
    {
        return privateKey.Decrypt(ciphertext, RSAEncryptionPadding.OaepSHA256);
    }

    /// <summary>
    /// Export public key in PEM format.
    /// </summary>
    public static string ExportPublicKeyPem(RSA rsa)
    {
        return rsa.ExportRSAPublicKeyPem();
    }

    /// <summary>
    /// Export private key in PEM format (protect this!).
    /// </summary>
    public static string ExportPrivateKeyPem(RSA rsa)
    {
        return rsa.ExportRSAPrivateKeyPem();
    }
}
```

#### RSA Key Size Guidelines

| Key Size | Security Level | Recommendation |
|----------|---------------|----------------|
| 1024 bits | ~80 bits | ❌ Deprecated |
| 2048 bits | ~112 bits | ✅ Minimum acceptable |
| 3072 bits | ~128 bits | ✅ Recommended |
| 4096 bits | ~140 bits | ✅ Long-term security |

### Elliptic Curve Cryptography (ECC)

Provides equivalent security with smaller key sizes.

```csharp
using System.Security.Cryptography;

// Generate ECDH key pair
using var ecdh = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
var publicKey = ecdh.PublicKey;

/// <summary>
/// Perform ECDH key exchange and derive key using HKDF.
/// </summary>
public static byte[] EcdhKeyExchange(
    ECDiffieHellman privateKey,
    ECDiffieHellmanPublicKey peerPublicKey)
{
    // Derive shared secret
    var sharedKey = privateKey.DeriveKeyMaterial(peerPublicKey);

    // Derive actual key using HKDF
    return HKDF.DeriveKey(
        HashAlgorithmName.SHA256,
        sharedKey,
        outputLength: 32,
        salt: null,
        info: "encryption key"u8.ToArray()
    );
}

// Alternative: Using DeriveKeyFromHash directly
public static byte[] EcdhKeyExchangeSimple(
    ECDiffieHellman privateKey,
    ECDiffieHellmanPublicKey peerPublicKey)
{
    return privateKey.DeriveKeyFromHash(
        peerPublicKey,
        HashAlgorithmName.SHA256,
        secretPrepend: null,
        secretAppend: "encryption key"u8.ToArray()
    );
}
```

#### ECC Curve Comparison

| Curve | Key Size | Security Level | Use Case |
|-------|----------|----------------|----------|
| P-256 (secp256r1) | 256 bits | ~128 bits | General use, NIST standard |
| P-384 (secp384r1) | 384 bits | ~192 bits | Higher security |
| P-521 (secp521r1) | 521 bits | ~256 bits | Maximum security |
| Curve25519 | 256 bits | ~128 bits | Modern, high performance |

## Digital Signatures

### Ed25519 (Recommended)

```csharp
using System.Security.Cryptography;
using NSec.Cryptography;

// Using NSec library (recommended for Ed25519)
// Install: dotnet add package NSec.Cryptography

// Generate key pair
using var key = Key.Create(SignatureAlgorithm.Ed25519);
var publicKey = key.PublicKey;

// Sign
var signature = SignatureAlgorithm.Ed25519.Sign(key, message);

// Verify (returns false if invalid, doesn't throw)
var isValid = SignatureAlgorithm.Ed25519.Verify(publicKey, message, signature);

// Alternative using .NET 9+ built-in support (preview)
// using var ed25519 = new Ed25519();
// var signature = ed25519.SignData(message);
// var isValid = ed25519.VerifyData(message, signature);
```

### ECDSA

```csharp
using System.Security.Cryptography;

// Generate key pair
using var ecdsa = ECDsa.Create(ECCurve.NamedCurves.nistP256);

// Sign
var signature = ecdsa.SignData(message, HashAlgorithmName.SHA256);

// Verify
var isValid = ecdsa.VerifyData(message, signature, HashAlgorithmName.SHA256);

// Export/Import keys
var privateKeyPem = ecdsa.ExportECPrivateKeyPem();
var publicKeyPem = ecdsa.ExportSubjectPublicKeyInfoPem();
```

### RSA Signatures

```csharp
using System.Security.Cryptography;

using var rsa = RSA.Create(2048);

// Sign with RSA-PSS (recommended)
var signature = rsa.SignData(
    message,
    HashAlgorithmName.SHA256,
    RSASignaturePadding.Pss
);

// Verify
var isValid = rsa.VerifyData(
    message,
    signature,
    HashAlgorithmName.SHA256,
    RSASignaturePadding.Pss
);

// Alternative: PKCS#1 v1.5 padding (for legacy compatibility only)
var signaturePkcs1 = rsa.SignData(
    message,
    HashAlgorithmName.SHA256,
    RSASignaturePadding.Pkcs1
);
```

#### Signature Algorithm Comparison

| Algorithm | Key Size | Signature Size | Performance | Recommendation |
|-----------|----------|----------------|-------------|----------------|
| Ed25519 | 32 bytes | 64 bytes | Fast | ✅ Best choice |
| ECDSA P-256 | 32 bytes | 64 bytes | Fast | ✅ Good for JWT |
| RSA-PSS 2048 | 256 bytes | 256 bytes | Moderate | ✅ When RSA required |
| RSA-PSS 4096 | 512 bytes | 512 bytes | Slow | ⚠️ Only if needed |

## Hash Functions

### Cryptographic Hashes

```csharp
using System.Security.Cryptography;

// SHA-256 (recommended for general use)
var hashSha256 = SHA256.HashData(data);

// SHA-384
var hashSha384 = SHA384.HashData(data);

// SHA-512
var hashSha512 = SHA512.HashData(data);

// SHA-3-256 (.NET 9+)
var hashSha3 = SHA3_256.HashData(data);

// BLAKE2b (requires external package or .NET 10+)
// Install: dotnet add package NSec.Cryptography
// var hashBlake2 = Blake2b.Hash(data);

// Alternative: Incremental hashing for large data
using var sha256 = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
sha256.AppendData(chunk1);
sha256.AppendData(chunk2);
var finalHash = sha256.GetHashAndReset();
```

### HMAC (Message Authentication)

```csharp
using System.Security.Cryptography;

/// <summary>
/// Create HMAC-SHA256.
/// </summary>
public static byte[] CreateHmac(byte[] key, byte[] message)
{
    return HMACSHA256.HashData(key, message);
}

/// <summary>
/// Verify HMAC using constant-time comparison.
/// </summary>
public static bool VerifyHmac(byte[] key, byte[] message, byte[] expected)
{
    var actual = CreateHmac(key, message);
    return CryptographicOperations.FixedTimeEquals(actual, expected);
}

// Alternative: Reusable HMAC instance for multiple operations
public sealed class HmacAuthenticator(byte[] key) : IDisposable
{
    private readonly HMACSHA256 _hmac = new(key);

    public byte[] ComputeHash(byte[] message) => _hmac.ComputeHash(message);

    public bool Verify(byte[] message, byte[] expected)
    {
        var actual = ComputeHash(message);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    public void Dispose() => _hmac.Dispose();
}
```

## Key Derivation Functions

### HKDF (for deriving keys from shared secrets)

```csharp
using System.Security.Cryptography;

/// <summary>
/// Derive key using HKDF.
/// </summary>
public static byte[] DeriveKey(
    byte[] inputKey,
    byte[]? salt,
    byte[] info,
    int length)
{
    return HKDF.DeriveKey(
        HashAlgorithmName.SHA256,
        inputKey,
        length,
        salt,
        info
    );
}

// Separate Extract and Expand operations
public static byte[] HkdfExtractAndExpand(
    byte[] inputKey,
    byte[]? salt,
    byte[] info,
    int length)
{
    // Extract phase: create pseudorandom key
    var prk = HKDF.Extract(HashAlgorithmName.SHA256, inputKey, salt);

    // Expand phase: expand to desired length
    return HKDF.Expand(HashAlgorithmName.SHA256, prk, length, info);
}
```

### scrypt (for password-based key derivation)

```csharp
using System.Security.Cryptography;

/// <summary>
/// Derive encryption key from password using scrypt.
/// Note: .NET doesn't have built-in scrypt. Use Argon2id instead (preferred)
/// or install a third-party package like BCrypt.Net-Next or Konscious.Security.Cryptography
/// </summary>
public static (byte[] Key, byte[] Salt) DeriveKeyFromPassword(
    string password,
    byte[]? salt = null)
{
    salt ??= RandomNumberGenerator.GetBytes(16);

    // Using Rfc2898DeriveBytes with SHA256 as alternative
    // For actual scrypt, use third-party library
    using var pbkdf2 = new Rfc2898DeriveBytes(
        password,
        salt,
        iterations: 600_000, // OWASP recommendation for PBKDF2-SHA256
        HashAlgorithmName.SHA256
    );

    var key = pbkdf2.GetBytes(32);
    return (key, salt);
}

// Preferred: Use Argon2id (requires Konscious.Security.Cryptography)
// Install: dotnet add package Konscious.Security.Cryptography.Argon2
/*
public static (byte[] Key, byte[] Salt) DeriveKeyWithArgon2(
    string password,
    byte[]? salt = null)
{
    salt ??= RandomNumberGenerator.GetBytes(16);

    using var argon2 = new Argon2id(Encoding.UTF8.GetBytes(password))
    {
        Salt = salt,
        DegreeOfParallelism = 4,
        MemorySize = 65536,  // 64 MB
        Iterations = 3
    };

    var key = argon2.GetBytes(32);
    return (key, salt);
}
*/
```

## Deprecated Algorithms

### Never Use These

| Algorithm | Reason | Alternative |
|-----------|--------|-------------|
| MD5 | Collision attacks | SHA-256 |
| SHA-1 | Collision attacks | SHA-256 |
| DES | 56-bit key, brute-forceable | AES-256 |
| RC4 | Multiple attacks | AES-GCM or ChaCha20 |
| RSA PKCS#1 v1.5 enc | Padding oracle attacks | RSA-OAEP |
| ECB mode | Patterns preserved | GCM or CTR+MAC |

### Migration Path

```csharp
using System.Security.Cryptography;

// Old (vulnerable) - DO NOT USE
#pragma warning disable CA5351 // Do Not Use Broken Cryptographic Algorithms
var hashMd5 = Convert.ToHexString(MD5.HashData(data));
#pragma warning restore CA5351

// New (secure)
var hashSha256 = Convert.ToHexString(SHA256.HashData(data));

/// <summary>
/// Verify hash, supporting legacy MD5 and new SHA-256.
/// </summary>
public static (bool IsValid, bool NeedsUpgrade) VerifyLegacyHash(byte[] data, string storedHash)
{
    return storedHash.Length switch
    {
        32 => // MD5 hex
        (
            #pragma warning disable CA5351
            Convert.ToHexString(MD5.HashData(data)).Equals(storedHash, StringComparison.OrdinalIgnoreCase),
            #pragma warning restore CA5351
            true  // Flag for upgrade
        ),

        64 => // SHA-256 hex
        (
            Convert.ToHexString(SHA256.HashData(data)).Equals(storedHash, StringComparison.OrdinalIgnoreCase),
            false  // Already using secure algorithm
        ),

        _ => (false, false)
    };
}

// Usage:
// var (isValid, needsUpgrade) = VerifyLegacyHash(data, storedHash);
// if (isValid && needsUpgrade)
// {
//     // Re-hash with SHA-256 and update storage
//     var newHash = Convert.ToHexString(SHA256.HashData(data));
//     UpdateStoredHash(newHash);
// }
```

## Security Level Equivalencies

| Symmetric | RSA | ECC | Hash | Security Bits |
|-----------|-----|-----|------|---------------|
| AES-128 | RSA-3072 | P-256 | SHA-256 | 128 |
| AES-192 | RSA-7680 | P-384 | SHA-384 | 192 |
| AES-256 | RSA-15360 | P-521 | SHA-512 | 256 |

**Rule of thumb:** For equivalent security, use algorithms from the same row.
