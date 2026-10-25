/**
 * Fixed sizes and labels from the age v1 specification (https://c2sp.org/age).
 *
 * Every number here is dictated by the spec; changing any of them would produce
 * files that the official `age` CLI cannot read. Section names in comments refer
 * to the spec's headings.
 */

/** The first line of every age v1 file, including its line feed ("Version line"). */
export const VERSION_LINE = "age-encryption.org/v1\n";

/**
 * The part of the version line shared by all age versions. Used to tell
 * "not an age file at all" apart from "an age file of a newer version".
 */
export const VERSION_PREFIX = "age-encryption.org/";

/** The file key is 16 bytes (128 bits) of CSPRNG output ("File key"). */
export const FILE_KEY_SIZE = 16;

/** The payload starts with a 16-byte random nonce ("Payload"). */
export const PAYLOAD_NONCE_SIZE = 16;

/** Plaintext is split into 64 KiB chunks ("Payload"). */
export const CHUNK_SIZE = 64 * 1024;

/** ChaCha20-Poly1305 appends a 16-byte authentication tag to every ciphertext. */
export const TAG_SIZE = 16;

/** A full encrypted chunk on disk: 64 KiB of ciphertext plus its tag. */
export const ENCRYPTED_CHUNK_SIZE = CHUNK_SIZE + TAG_SIZE;

/** ChaCha20-Poly1305 nonces are 12 bytes (RFC 7539). */
export const AEAD_NONCE_SIZE = 12;

/** Keys derived with HKDF-SHA-256 are always 32 bytes ("Conventions"). */
export const DERIVED_KEY_SIZE = 32;

/**
 * A wrapped file key in a native stanza body: 16-byte file key + 16-byte tag.
 * The spec requires identities to check this exact length *before* trying to
 * decrypt, to avoid partitioning-oracle attacks ("X25519 recipient stanza").
 */
export const WRAPPED_FILE_KEY_SIZE = FILE_KEY_SIZE + TAG_SIZE;

/** Stanza bodies are base64 wrapped at 64 columns ("Recipient stanza"). */
export const STANZA_LINE_COLUMNS = 64;

/** HKDF info for the header MAC key ("Header MAC"). */
export const HEADER_MAC_INFO = "header";

/** HKDF info for the payload key ("Payload"). */
export const PAYLOAD_KEY_INFO = "payload";

/** HKDF info for the X25519 wrap key ("X25519 recipient stanza"). */
export const X25519_INFO = "age-encryption.org/v1/X25519";

/** Prefix of the scrypt salt ("scrypt recipient stanza"). */
export const SCRYPT_SALT_LABEL = "age-encryption.org/v1/scrypt";

/**
 * Upper bound on the header size MongoShield will buffer while looking for the
 * end of the header. The spec sets no limit, but a native X25519 stanza is
 * about 100 bytes, so 1 MiB leaves room for thousands of recipients while
 * keeping memory bounded when fed garbage.
 */
export const MAX_HEADER_SIZE = 1024 * 1024;
