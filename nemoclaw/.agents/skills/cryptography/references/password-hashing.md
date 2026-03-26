# Password Hashing Reference

This reference provides comprehensive guidance for secure password hashing.

## Why Specialized Password Hashing?

General-purpose hash functions (SHA-256, MD5) are designed to be **fast**. This is bad for passwords because:

1. **Brute force attacks**: Fast hashing allows billions of guesses per second
2. **Rainbow tables**: Pre-computed hash tables can crack passwords instantly
3. **GPU acceleration**: GPUs can compute trillions of SHA-256 hashes per second

**Password hashing algorithms** are intentionally **slow** and **memory-intensive** to make attacks impractical.

## Algorithm Deep Dive

### Argon2id (Recommended)

Winner of the Password Hashing Competition (PHC) in 2015. Combines:

- **Argon2d**: Data-dependent memory access (GPU-resistant)
- **Argon2i**: Data-independent access (side-channel resistant)
- **Argon2id**: Hybrid (best of both)

```csharp
using System.Security.Cryptography;
using Konscious.Security.Cryptography;  // NuGet: Konscious.Security.Cryptography.Argon2

/// <summary>
/// Production-ready Argon2id password hasher.
/// </summary>
public sealed class SecurePasswordHasher
{
    // OWASP 2023 recommended parameters
    private const int TimeCost = 3;         // Number of iterations
    private const int MemoryCost = 65536;   // 64 MB (in KB)
    private const int Parallelism = 4;      // Parallel threads
    private const int HashLength = 32;      // Output hash length
    private const int SaltLength = 16;      // Salt length

    /// <summary>
    /// Hash a password. Returns PHC string format.
    /// </summary>
    public string Hash(string password)
    {
        ArgumentNullException.ThrowIfNull(password);
        if (password.Length > 128)
            throw new ArgumentException("Password too long", nameof(password));

        var salt = RandomNumberGenerator.GetBytes(SaltLength);

        using var argon2 = new Argon2id(System.Text.Encoding.UTF8.GetBytes(password))
        {
            Salt = salt,
            DegreeOfParallelism = Parallelism,
            MemorySize = MemoryCost,
            Iterations = TimeCost
        };

        var hash = argon2.GetBytes(HashLength);

        // PHC string format: $argon2id$v=19$m=65536,t=3,p=4$salt$hash
        return $"$argon2id$v=19$m={MemoryCost},t={TimeCost},p={Parallelism}$" +
               $"{Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    /// <summary>
    /// Verify password against hash.
    /// </summary>
    public bool Verify(string storedHash, string password)
    {
        try
        {
            var parts = storedHash.Split('$');
            if (parts.Length < 6 || parts[1] != "argon2id")
                return false;  // Invalid hash format - log this

            var parameters = ParseParameters(parts[3]);
            var salt = Convert.FromBase64String(parts[4]);
            var expectedHash = Convert.FromBase64String(parts[5]);

            using var argon2 = new Argon2id(System.Text.Encoding.UTF8.GetBytes(password))
            {
                Salt = salt,
                DegreeOfParallelism = parameters.Parallelism,
                MemorySize = parameters.Memory,
                Iterations = parameters.Time
            };

            var computedHash = argon2.GetBytes(expectedHash.Length);
            return CryptographicOperations.FixedTimeEquals(computedHash, expectedHash);
        }
        catch
        {
            // Log this - might indicate tampering
            return false;
        }
    }

    /// <summary>
    /// Check if hash needs to be upgraded (parameters changed).
    /// </summary>
    public bool NeedsRehash(string storedHash)
    {
        try
        {
            var parts = storedHash.Split('$');
            if (parts.Length < 4) return true;

            var parameters = ParseParameters(parts[3]);
            return parameters.Memory != MemoryCost ||
                   parameters.Time != TimeCost ||
                   parameters.Parallelism != Parallelism;
        }
        catch
        {
            return true;  // Invalid format, needs rehash
        }
    }

    private static (int Memory, int Time, int Parallelism) ParseParameters(string paramString)
    {
        int m = 0, t = 0, p = 0;
        foreach (var param in paramString.Split(','))
        {
            var kv = param.Split('=');
            if (kv.Length == 2)
            {
                _ = kv[0] switch
                {
                    "m" => m = int.Parse(kv[1]),
                    "t" => t = int.Parse(kv[1]),
                    "p" => p = int.Parse(kv[1]),
                    _ => 0
                };
            }
        }
        return (m, t, p);
    }
}

// Usage
var hasher = new SecurePasswordHasher();
var hash = hasher.Hash("user_password");
// $argon2id$v=19$m=65536,t=3,p=4$salthere$hashhere

if (hasher.Verify(hash, "user_password"))
{
    if (hasher.NeedsRehash(hash))
    {
        // Re-hash with new parameters on successful login
        var newHash = hasher.Hash("user_password");
        UpdateStoredHash(userId, newHash);
    }
}
```

### bcrypt

Mature, widely-supported algorithm based on Blowfish cipher.

```csharp
using System.Security.Cryptography;
using BCrypt.Net;  // NuGet: BCrypt.Net-Next

/// <summary>
/// bcrypt password hasher.
/// </summary>
public sealed class BcryptHasher(int workFactor = 12)
{
    /// <summary>
    /// Hash password with bcrypt.
    /// </summary>
    public string Hash(string password)
    {
        ArgumentNullException.ThrowIfNull(password);

        // bcrypt truncates at 72 bytes - pre-hash if longer
        if (System.Text.Encoding.UTF8.GetByteCount(password) > 72)
        {
            password = Convert.ToHexString(SHA256.HashData(
                System.Text.Encoding.UTF8.GetBytes(password))).ToLowerInvariant();
        }

        return BCrypt.Net.BCrypt.HashPassword(password, workFactor);
    }

    /// <summary>
    /// Verify password against stored hash.
    /// </summary>
    public bool Verify(string storedHash, string password)
    {
        ArgumentNullException.ThrowIfNull(password);

        // bcrypt truncates at 72 bytes - pre-hash if longer
        if (System.Text.Encoding.UTF8.GetByteCount(password) > 72)
        {
            password = Convert.ToHexString(SHA256.HashData(
                System.Text.Encoding.UTF8.GetBytes(password))).ToLowerInvariant();
        }

        return BCrypt.Net.BCrypt.Verify(password, storedHash);
    }
}
```

**bcrypt Limitations:**

- Truncates passwords at 72 bytes (pre-hash longer passwords)
- Not memory-hard (GPU attacks possible with enough memory)
- Work factor limited to ~31 (bcrypt rounds)

### scrypt

Memory-hard algorithm designed to be expensive for hardware attacks.

```csharp
using System.Security.Cryptography;
using Scrypt;  // NuGet: Scrypt.NET (or use PBKDF2 as built-in alternative)

/// <summary>
/// scrypt password hasher.
/// </summary>
public sealed class ScryptHasher(int n = 65536, int r = 8, int p = 1)
{
    private const int SaltLength = 16;
    private const int HashLength = 32;

    /// <summary>
    /// Hash password with scrypt.
    /// </summary>
    public string Hash(string password)
    {
        ArgumentNullException.ThrowIfNull(password);

        var salt = RandomNumberGenerator.GetBytes(SaltLength);
        var encoder = new ScryptEncoder(n, r, p);
        var derived = encoder.Encode(password);

        // Format: $scrypt$n$r$p$salt$hash
        // Note: ScryptEncoder includes salt in output, but for custom format:
        var hash = DeriveScryptKey(password, salt);
        return $"$scrypt${n}${r}${p}${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    /// <summary>
    /// Verify password against stored hash.
    /// </summary>
    public bool Verify(string stored, string password)
    {
        try
        {
            var parts = stored.Split('$');
            if (parts[1] != "scrypt")
                throw new ArgumentException("Not a scrypt hash");

            var n = int.Parse(parts[2]);
            var r = int.Parse(parts[3]);
            var p = int.Parse(parts[4]);
            var salt = Convert.FromBase64String(parts[5]);
            var expected = Convert.FromBase64String(parts[6]);

            var computed = DeriveScryptKey(password, salt, n, r, p);
            return CryptographicOperations.FixedTimeEquals(computed, expected);
        }
        catch
        {
            return false;
        }
    }

    private static byte[] DeriveScryptKey(string password, byte[] salt,
        int costN = 65536, int blockR = 8, int parallelP = 1)
    {
        // Using CryptSharp or similar library for raw scrypt
        // Alternative: Use PBKDF2 with high iterations if scrypt unavailable
        var encoder = new ScryptEncoder(costN, blockR, parallelP);
        // Implementation depends on specific scrypt library used
        // For Scrypt.NET, use ScryptEncoder.Compare for verification
        throw new NotImplementedException("Use library-specific implementation");
    }
}

// Alternative: Using built-in PBKDF2 as fallback (not scrypt, but widely available)
public sealed class Pbkdf2ScryptAlternative(int iterations = 600000)
{
    public byte[] DeriveKey(string password, byte[] salt, int keyLength = 32)
    {
        using var pbkdf2 = new Rfc2898DeriveBytes(
            password,
            salt,
            iterations,
            HashAlgorithmName.SHA256);
        return pbkdf2.GetBytes(keyLength);
    }
}
```

### PBKDF2

NIST-approved but not memory-hard. Acceptable when other options unavailable.

```csharp
using System.Security.Cryptography;

/// <summary>
/// Hash password with PBKDF2-HMAC-SHA256.
/// </summary>
public static string Pbkdf2Hash(string password, int iterations = 600000)
{
    var salt = RandomNumberGenerator.GetBytes(16);
    using var pbkdf2 = new Rfc2898DeriveBytes(
        password,
        salt,
        iterations,
        HashAlgorithmName.SHA256);

    var derived = pbkdf2.GetBytes(32);
    // Format: $pbkdf2-sha256$iterations$salt$hash
    return $"$pbkdf2-sha256${iterations}${Convert.ToHexString(salt).ToLowerInvariant()}${Convert.ToHexString(derived).ToLowerInvariant()}";
}

/// <summary>
/// Verify password against PBKDF2 hash.
/// </summary>
public static bool Pbkdf2Verify(string stored, string password)
{
    var parts = stored.Split('$');
    var iterations = int.Parse(parts[2]);
    var salt = Convert.FromHexString(parts[3]);
    var expected = Convert.FromHexString(parts[4]);

    using var pbkdf2 = new Rfc2898DeriveBytes(
        password,
        salt,
        iterations,
        HashAlgorithmName.SHA256);

    var derived = pbkdf2.GetBytes(32);
    return CryptographicOperations.FixedTimeEquals(derived, expected);
}
```

## Parameter Tuning

### Target Execution Time

Hash verification should take **100-500ms** on your target hardware. Adjust parameters to hit this target.

### Argon2id Parameter Recommendations

| Use Case | time_cost | memory_cost | parallelism |
|----------|-----------|-------------|-------------|
| Low-end server | 2 | 19456 (19 MB) | 1 |
| Standard server | 3 | 65536 (64 MB) | 4 |
| High-security | 4 | 131072 (128 MB) | 4 |
| Maximum security | 5 | 262144 (256 MB) | 8 |

```csharp
using System.Diagnostics;
using Konscious.Security.Cryptography;

/// <summary>
/// Find optimal Argon2 parameters for current hardware.
/// </summary>
public static void TuneArgon2Parameters()
{
    const double targetTimeSeconds = 0.3;  // 300ms target
    const string testPassword = "test_password_123";
    var passwordBytes = System.Text.Encoding.UTF8.GetBytes(testPassword);
    var salt = new byte[16];  // Zero salt is fine for tuning

    int[] memoryOptions = [19456, 32768, 65536, 131072];
    int[] timeCostOptions = [1, 2, 3, 4, 5];

    foreach (var memory in memoryOptions)
    {
        foreach (var timeCost in timeCostOptions)
        {
            using var argon2 = new Argon2id(passwordBytes)
            {
                Salt = salt,
                DegreeOfParallelism = 4,
                MemorySize = memory,
                Iterations = timeCost
            };

            var stopwatch = Stopwatch.StartNew();
            _ = argon2.GetBytes(32);
            stopwatch.Stop();

            var elapsed = stopwatch.Elapsed.TotalSeconds;
            Console.WriteLine($"memory={memory}KB, time={timeCost}: {elapsed:F3}s");

            if (elapsed >= targetTimeSeconds)
            {
                Console.WriteLine($"\nRecommended: time_cost={timeCost}, memory_cost={memory}");
                return;
            }
        }
    }
}
```

### bcrypt Work Factor

| Work Factor | Approximate Time | Recommendation |
|-------------|------------------|----------------|
| 10 | ~100ms | Minimum |
| 11 | ~200ms | Low-end systems |
| 12 | ~400ms | **Recommended** |
| 13 | ~800ms | High security |
| 14 | ~1.6s | Maximum practical |

## Migration Strategies

### From MD5/SHA-1 to Argon2id

```csharp
using System.Security.Cryptography;

/// <summary>
/// Migrate passwords from weak to strong hashing.
/// </summary>
public sealed class PasswordMigrator
{
    private readonly SecurePasswordHasher _argon2 = new();

    /// <summary>
    /// Verify password and upgrade hash if using legacy format.
    /// </summary>
    public bool VerifyAndUpgrade(string storedHash, string password, string userId)
    {
        if (storedHash.StartsWith("$argon2", StringComparison.Ordinal))
        {
            // Already using Argon2
            return _argon2.Verify(storedHash, password);
        }

        if (storedHash.Length == 32)
        {
            // Looks like MD5
            #pragma warning disable CA5351  // Legacy migration only
            var computed = Convert.ToHexString(
                MD5.HashData(System.Text.Encoding.UTF8.GetBytes(password))).ToLowerInvariant();
            #pragma warning restore CA5351

            if (string.Equals(computed, storedHash, StringComparison.OrdinalIgnoreCase))
            {
                // Valid password, upgrade hash
                var newHash = _argon2.Hash(password);
                UpdateHash(userId, newHash);
                return true;
            }
            return false;
        }

        if (storedHash.Length == 64)
        {
            // Looks like SHA-256
            var computed = Convert.ToHexString(
                SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(password))).ToLowerInvariant();

            if (string.Equals(computed, storedHash, StringComparison.OrdinalIgnoreCase))
            {
                var newHash = _argon2.Hash(password);
                UpdateHash(userId, newHash);
                return true;
            }
            return false;
        }

        // Unknown format
        throw new ArgumentException("Unknown hash format", nameof(storedHash));
    }

    /// <summary>
    /// Update user's password hash in database.
    /// </summary>
    private static void UpdateHash(string userId, string newHash)
    {
        // Implementation depends on your data layer
    }
}
```

### Wrap-and-Migrate Pattern

For systems that can't require password re-entry:

```csharp
/// <summary>
/// Wrap legacy hash with Argon2id.
/// The legacy hash becomes the "password" for Argon2.
/// This provides protection even without user re-authentication.
/// </summary>
public static string WrapLegacyHash(string legacyHash)
{
    var hasher = new SecurePasswordHasher();
    return $"wrapped:{hasher.Hash(legacyHash)}";
}

/// <summary>
/// Verify wrapped hash.
/// </summary>
public static bool VerifyWrapped(string stored, string legacyHash)
{
    if (stored.StartsWith("wrapped:", StringComparison.Ordinal))
    {
        var argon2Hash = stored[8..];  // Skip "wrapped:" prefix
        var hasher = new SecurePasswordHasher();
        return hasher.Verify(argon2Hash, legacyHash);
    }
    return false;
}
```

## Common Mistakes

### 1. Using Fast Hashes

```csharp
// WRONG - SHA-256 is too fast
var passwordHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(password)));

// RIGHT - Use password-specific hash
var hasher = new SecurePasswordHasher();
var passwordHash = hasher.Hash(password);
```

### 2. Short or Predictable Salts

```csharp
// WRONG - Predictable salt
var salt = userId;  // Attacker knows this

// WRONG - Too short
var salt = RandomNumberGenerator.GetBytes(4);  // Only 32 bits

// RIGHT - Random 16-byte salt
var salt = RandomNumberGenerator.GetBytes(16);
```

### 3. Not Using Constant-Time Comparison

```csharp
// WRONG - Timing attack possible
if (storedHash == computedHash)
    return true;

// RIGHT - Constant-time comparison
if (CryptographicOperations.FixedTimeEquals(
    Encoding.UTF8.GetBytes(storedHash),
    Encoding.UTF8.GetBytes(computedHash)))
    return true;
```

### 4. Truncating Passwords

```csharp
// WRONG - Silently truncating
if (password.Length > 72)
    password = password[..72];  // User doesn't know!

// RIGHT - Pre-hash long passwords
if (Encoding.UTF8.GetByteCount(password) > 72)
{
    password = Convert.ToHexString(
        SHA256.HashData(Encoding.UTF8.GetBytes(password))).ToLowerInvariant();
}
```

## Security Checklist

- [ ] Using Argon2id, bcrypt, or scrypt (not MD5/SHA)
- [ ] Using cryptographically random salts (16+ bytes)
- [ ] Salt is unique per password
- [ ] Work factor tuned for 100-500ms verification
- [ ] Using constant-time comparison
- [ ] Implementing rehash on parameter changes
- [ ] Handling long passwords correctly
- [ ] Limiting password length (DoS protection)
- [ ] Not logging passwords or hashes
- [ ] Migration path for legacy hashes
