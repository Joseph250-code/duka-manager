// ---- STK PUSH (REQUEST PAYMENT) ----
document.getElementById("stkForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const phone_number = document.getElementById("stkPhone").value;
    const amount = parseFloat(document.getElementById("stkAmount").value);
    const statusEl = document.getElementById("stkStatus");
    const submitBtn = document.getElementById("stkSubmitBtn");

    submitBtn.disabled = true;
    submitBtn.textContent = "Sending...";
    statusEl.textContent = "";

    const result = await apiCall("/stkpush", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_number, amount })
    });

    submitBtn.disabled = false;
    submitBtn.textContent = "Send payment request";

    if (result) {
        e.target.reset();
        statusEl.textContent = "Prompt sent — waiting for the customer to enter their PIN...";
        showToast("Payment request sent");

        // Poll the M-Pesa tab a few times so it refreshes once the customer pays
        let attempts = 0;
        const poll = setInterval(async () => {
            attempts++;
            await loadMpesa();
            await updateUnmatchedTotal();
            if (attempts >= 6) clearInterval(poll); // stop after ~30s
        }, 5000);
    } else {
        statusEl.textContent = "Something went wrong sending the request.";
    }
});