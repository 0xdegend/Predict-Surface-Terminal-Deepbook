/// Kelly chat Seal access policy — owner-only decryption.
///
/// Each conversation is Seal-encrypted to an IDENTITY that begins with the owner's 32-byte
/// Sui address, followed by the conversation id. When Seal releases a decryption key it runs
/// `seal_approve` in a dry run whose sender is the requester's certified session-key address,
/// so the key is granted only when the requester IS the owner the id is bound to. No shared
/// objects, no allowlist to maintain: your wallet, your chats.
///
/// This is the standard Seal "account / self" access pattern. Publish it once, then set the
/// resulting package id as NEXT_PUBLIC_SEAL_PACKAGE_ID (see README).
module kelly_chat_seal::policy {
    use sui::address;

    /// The requester is not the owner this id is bound to.
    const ENoAccess: u64 = 0;

    /// True when `prefix` is a prefix of `word`.
    fun is_prefix(prefix: vector<u8>, word: vector<u8>): bool {
        let plen = prefix.length();
        if (plen > word.length()) return false;
        let mut i = 0;
        while (i < plen) {
            if (prefix[i] != word[i]) return false;
            i = i + 1;
        };
        true
    }

    /// Seal calls this while releasing a key. `id` is the encryption identity; it must start
    /// with the 32-byte address of whoever is asking (the session key's certified sender), so
    /// only the owner an id was encrypted for can ever decrypt it.
    entry fun seal_approve(id: vector<u8>, ctx: &TxContext) {
        let sender = address::to_bytes(ctx.sender());
        assert!(is_prefix(sender, id), ENoAccess);
    }
}
