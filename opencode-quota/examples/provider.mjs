// Configure this file for a provider in the server plugin's providers options.
// The selected provider's active OpenCode connection supplies the credential.
export default async function quota({ credential, signal }) {
  if (credential?.type !== "key") throw new Error("Connect the provider first")
  const response = await fetch("https://api.example.com/account/quota", {
    headers: { Authorization: `Bearer ${credential.key}` }, signal, redirect: "error",
  })
  if (!response.ok) throw new Error("Quota request failed")
  const data = await response.json()
  return {
    title: "示例供应商",
    items: [
      { label: "余额", value: `$${Number(data.balance).toFixed(2)}` },
      { label: "月额度", used: data.used, limit: data.limit, unit: "次", resetsAt: data.resetsAt },
    ],
  }
}
