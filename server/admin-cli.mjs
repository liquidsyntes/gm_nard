import { createStore } from './store.mjs'
import { newId, newToken, tokenHash } from './auth.mjs'

const action = process.argv[2]
const name = process.argv[3]?.trim()
if (!['create', 'rotate'].includes(action) || !name || !/^[\p{L}\p{N}_ -]{3,32}$/u.test(name)) {
  console.error('Usage: npm run admin:create -- <name> or npm run admin:rotate -- <name>')
  process.exit(1)
}

const store = await createStore()
const token = newToken()
try {
  await store.transact(state => {
    const admins = state.users.filter(user => user.role === 'admin')
    if (action === 'create') {
      if (admins.length) throw new Error('Administrator already exists; use admin:rotate')
      state.users.push({ id: newId(), name, role: 'admin', tokenHash: tokenHash(token), disabled: false, createdAt: new Date().toISOString() })
    } else {
      const admin = admins.find(user => user.name.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU'))
      if (!admin) throw new Error('Administrator not found')
      admin.tokenHash = tokenHash(token)
      state.sessions = state.sessions.filter(session => session.userId !== admin.id)
    }
  })
  console.log(`Administrator: ${name}`)
  console.log(`Login token (shown once): ${token}`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
