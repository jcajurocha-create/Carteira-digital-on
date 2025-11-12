import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot, collection, query, addDoc, updateDoc, increment, runTransaction, serverTimestamp } from 'firebase/firestore';

// Função auxiliar para formatar valores monetários em BRL (Reais Brasileiros)
const formatCurrency = (amount) => {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(amount);
};

// --- Configurações e Inicialização do Firebase ---

// As variáveis globais são fornecidas pelo ambiente.
// Usamos valores padrão para garantir que o código seja executável fora do ambiente Canvas.
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-wallet-app';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// Inicialização de instâncias (serão definidas no useEffect)
let app, auth, db;

// Função de utilidade para adicionar atraso e simular o backoff exponencial (1s, 2s, 4s, 8s, ...)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const App = () => {
  const [userId, setUserId] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [balance, setBalance] = useState(0);
  const [transactions, setTransactions] = useState([]);
  const [view, setView] = useState('home'); // 'home' | 'transfer'
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  // 1. Inicialização do Firebase e Autenticação
  useEffect(() => {
    if (Object.keys(firebaseConfig).length === 0) {
      console.error("Firebase config is missing.");
      setError("Erro de configuração: Firebase não inicializado.");
      setIsLoading(false);
      return;
    }

    try {
      app = initializeApp(firebaseConfig);
      auth = getAuth(app);
      db = getFirestore(app);

      // Listener de estado de autenticação
      const unsubscribe = onAuthStateChanged(auth, async (user) => {
        if (user) {
          setUserId(user.uid);
          setIsAuthReady(true);
        } else {
          // Tentativa de login com token personalizado ou anônimo
          try {
            if (initialAuthToken) {
              await signInWithCustomToken(auth, initialAuthToken);
            } else {
              await signInAnonymously(auth);
            }
          } catch (e) {
            console.error("Erro ao autenticar no Firebase:", e);
            setError("Falha na autenticação. Verifique as credenciais.");
            setIsAuthReady(true); // Permitir que o app continue em estado de erro
          }
        }
        // Se o userId for definido ou se houver um erro de auth, saímos do estado de carregamento inicial
        if (auth.currentUser) setIsLoading(false);
      });

      return () => unsubscribe();
    } catch (e) {
      console.error("Erro fatal na inicialização do Firebase:", e);
      setError("Erro fatal: Não foi possível inicializar o aplicativo.");
      setIsLoading(false);
    }
  }, []);

  // Referências aos documentos e coleções (paths públicos/privados)
  const balanceDocRef = useMemo(() => {
    if (!db || !userId) return null;
    // Saldo: Público (para permitir "transferências" entre usuários)
    return doc(db, `artifacts/${appId}/public/data/users/${userId}`);
  }, [db, userId]);

  const transactionsColRef = useMemo(() => {
    if (!db || !userId) return null;
    // Histórico: Privado (apenas para o log de transações do próprio usuário)
    return collection(db, `artifacts/${appId}/users/${userId}/transactions`);
  }, [db, userId]);

  // 2. Leitura de Dados em Tempo Real (Balance e Transactions)
  useEffect(() => {
    if (!isAuthReady || !userId || !balanceDocRef || !transactionsColRef) return;

    // A) Listener do Saldo
    const unsubscribeBalance = onSnapshot(balanceDocRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setBalance(data.amount || 0);
      } else {
        // Se o documento não existe, inicializa com 0
        setDoc(balanceDocRef, { amount: 0, userId, createdAt: serverTimestamp() }, { merge: true })
          .catch(e => console.error("Erro ao inicializar saldo:", e));
        setBalance(0);
      }
    }, (e) => console.error("Erro ao subscrever o saldo:", e));

    // B) Listener das Transações (ordenadas por data)
    // NOTE: Não usamos orderBy() devido à restrição de índice. Ordenamos em memória.
    const unsubscribeTransactions = onSnapshot(query(transactionsColRef), (snapshot) => {
      const txs = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      // Ordena por timestamp (mais recente primeiro)
      txs.sort((a, b) => (b.timestamp?.toMillis() || 0) - (a.timestamp?.toMillis() || 0));
      setTransactions(txs);
      setIsLoading(false);
    }, (e) => console.error("Erro ao subscrever transações:", e));

    return () => {
      unsubscribeBalance();
      unsubscribeTransactions();
    };
  }, [isAuthReady, userId, balanceDocRef, transactionsColRef]);

  // 3. Funções de Transação

  const clearMessages = () => {
    setMessage('');
    setError('');
  };

  // 3.1. Simulação de Depósito
  const handleDeposit = useCallback(async (amount) => {
    clearMessages();
    if (amount <= 0 || !balanceDocRef) {
      setError("Valor de depósito inválido.");
      return;
    }

    try {
      await updateDoc(balanceDocRef, {
        amount: increment(amount),
      });

      await addDoc(transactionsColRef, {
        type: 'DEPOSITO',
        amount: amount,
        description: `Depósito em conta`,
        timestamp: serverTimestamp(),
      });

      setMessage(`Depósito de ${formatCurrency(amount)} realizado com sucesso!`);
    } catch (e) {
      console.error("Erro ao realizar depósito:", e);
      setError("Falha ao processar o depósito.");
    }
  }, [balanceDocRef, transactionsColRef]);

  // 3.2. Simulação de Transferência entre usuários (usando Firestore Transaction)
  const handleTransfer = useCallback(async (recipientId, amount) => {
    clearMessages();
    if (amount <= 0 || !balanceDocRef || recipientId === userId) {
      setError("Valor de transferência inválido ou ID do destinatário inválido.");
      return;
    }

    const recipientBalanceRef = doc(db, `artifacts/${appId}/public/data/users/${recipientId}`);

    try {
      await runTransaction(db, async (transaction) => {
        // 1. Obter saldos
        const senderSnapshot = await transaction.get(balanceDocRef);
        const recipientSnapshot = await transaction.get(recipientBalanceRef);

        const currentBalance = senderSnapshot.data()?.amount || 0;

        // 2. Checar saldo do remetente
        if (currentBalance < amount) {
          throw new Error("Saldo insuficiente para a transferência.");
        }

        // 3. Atualizar remetente
        transaction.update(balanceDocRef, {
          amount: increment(-amount),
        });

        // 4. Atualizar destinatário (se o documento não existir, ele será criado/mesclado)
        if (recipientSnapshot.exists()) {
          transaction.update(recipientBalanceRef, {
            amount: increment(amount),
          });
        } else {
          // Inicializar o saldo do destinatário se ele não existir
          transaction.set(recipientBalanceRef, {
            amount: amount,
            userId: recipientId,
            createdAt: serverTimestamp(),
          }, { merge: true });
        }

        // 5. Registrar transação no histórico do remetente
        // Nota: A adição ao histórico é feita fora da transação de saldo para evitar complexidade excessiva,
        // mas em um sistema real, toda a lógica de histórico e saldo seria atômica.
      });

      // Se a transação no Firestore for bem-sucedida, registramos o histórico (fora do bloco runTransaction)
      await addDoc(transactionsColRef, {
        type: 'TRANSFERENCIA_ENVIADA',
        amount: amount,
        recipient: recipientId,
        description: `Transferência enviada para ${recipientId}`,
        timestamp: serverTimestamp(),
      });

      // Simulamos o registro no histórico do destinatário (se este fosse o app dele, veria isso)
      const recipientTransactionsColRef = collection(db, `artifacts/${appId}/users/${recipientId}/transactions`);
       await addDoc(recipientTransactionsColRef, {
        type: 'TRANSFERENCIA_RECEBIDA',
        amount: amount,
        sender: userId,
        description: `Transferência recebida de ${userId}`,
        timestamp: serverTimestamp(),
      }).catch(e => console.warn("Aviso: Falha ao simular histórico do destinatário.", e));


      setMessage(`Transferência de ${formatCurrency(amount)} para ${recipientId} enviada com sucesso!`);
    } catch (e) {
      console.error("Erro ao realizar transferência:", e.message);
      setError(`Falha na transferência: ${e.message}`);
    }
    setView('home'); // Volta para a tela inicial
  }, [balanceDocRef, transactionsColRef, userId]);

  // --- Componentes da UI ---

  // Componente de carregamento
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="text-xl font-semibold text-indigo-600">
          Carregando Carteira Digital...
        </div>
      </div>
    );
  }

  // Componente de Transação (Formulário)
  const TransferView = () => {
    const [recipient, setRecipient] = useState('');
    const [amount, setAmount] = useState('');

    const handleSubmit = (e) => {
      e.preventDefault();
      const transferAmount = parseFloat(amount.replace(',', '.'));
      if (isNaN(transferAmount) || transferAmount <= 0) {
        setError("Por favor, insira um valor válido.");
        return;
      }
      handleTransfer(recipient, transferAmount);
    };

    return (
      <div className="p-6 bg-white rounded-xl shadow-lg w-full max-w-lg mx-auto">
        <h2 className="text-2xl font-bold mb-4 text-gray-800">Nova Transferência</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="recipient" className="block text-sm font-medium text-gray-700">ID do Destinatário</label>
            <input
              id="recipient"
              type="text"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="Ex: 1a2b3c4d5e6f..."
              required
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
            />
             <p className="mt-1 text-xs text-gray-500">
                Para testar, envie este ID para um amigo ou use o seu próprio ID para ver o erro de auto-envio: <span className="font-mono bg-gray-100 p-1 rounded text-sm text-indigo-700">{userId}</span>
             </p>
          </div>
          <div>
            <label htmlFor="amount" className="block text-sm font-medium text-gray-700">Valor (R$)</label>
            <input
              id="amount"
              type="number"
              step="0.01"
              min="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
            />
          </div>
          <div className="flex justify-between space-x-3">
            <button
              type="button"
              onClick={() => setView('home')}
              className="w-full inline-flex justify-center py-3 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-gray-700 bg-gray-200 hover:bg-gray-300 transition duration-150 ease-in-out"
            >
              Voltar
            </button>
            <button
              type="submit"
              className="w-full inline-flex justify-center py-3 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition duration-150 ease-in-out"
            >
              Enviar Transferência
            </button>
          </div>
        </form>
      </div>
    );
  };

  // Componente de Depósito (Modal/Box)
  const DepositBox = () => {
    const [depositAmount, setDepositAmount] = useState('');
    const handleDepositSubmit = () => {
      const amount = parseFloat(depositAmount.replace(',', '.'));
      if (amount > 0) {
        handleDeposit(amount);
        setDepositAmount('');
      } else {
        setError("Por favor, insira um valor de depósito válido.");
      }
    };

    return (
      <div className="p-4 bg-indigo-100 border border-indigo-200 rounded-lg shadow-inner flex flex-col md:flex-row gap-3 items-center">
        <input
          type="number"
          step="0.01"
          min="0.01"
          value={depositAmount}
          onChange={(e) => setDepositAmount(e.target.value)}
          placeholder="Valor do Depósito (R$)"
          className="w-full md:w-auto flex-grow px-3 py-2 border border-indigo-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
        />
        <button
          onClick={handleDepositSubmit}
          className="w-full md:w-auto flex-shrink-0 inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 transition duration-150 ease-in-out"
        >
          Depositar
        </button>
      </div>
    );
  };

  // Componente de Histórico de Transações
  const TransactionHistory = () => (
    <div className="mt-8">
      <h3 className="text-xl font-semibold mb-3 text-gray-800">Histórico de Transações</h3>
      {transactions.length === 0 ? (
        <p className="text-gray-500">Nenhuma transação ainda.</p>
      ) : (
        <div className="bg-white rounded-xl shadow overflow-hidden">
          {transactions.map((tx, index) => {
            const isDeposit = tx.type === 'DEPOSITO';
            const isSent = tx.type === 'TRANSFERENCIA_ENVIADA';
            const isReceived = tx.type === 'TRANSFERENCIA_RECEBIDA';

            const colorClass = isDeposit ? 'text-green-600' : isReceived ? 'text-green-600' : 'text-red-600';
            const sign = isDeposit || isReceived ? '+' : '-';

            return (
              <div
                key={tx.id}
                className={`p-4 border-b last:border-b-0 flex justify-between items-center transition duration-150 ease-in-out ${index % 2 === 0 ? 'bg-gray-50' : 'bg-white'}`}
              >
                <div className="flex-1 min-w-0">
                  <p className={`font-medium ${colorClass}`}>
                    {tx.description}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {tx.timestamp ? new Date(tx.timestamp.toMillis()).toLocaleString('pt-BR') : 'Carregando Data...'}
                  </p>
                </div>
                <div className="text-right">
                  <span className={`font-bold ${colorClass}`}>
                    {sign} {formatCurrency(tx.amount)}
                  </span>
                  {(isSent || isReceived) && (
                    <p className="text-xs text-gray-500 mt-0.5 truncate">
                      {isSent ? `Para: ${tx.recipient}` : `De: ${tx.sender}`}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  // Componente de Visualização Principal (Home)
  const HomeView = () => (
    <div className="space-y-6">
      <div className="bg-indigo-600 p-6 rounded-xl shadow-2xl text-white">
        <h2 className="text-sm font-medium opacity-80">Saldo Atual</h2>
        <p className="text-4xl font-extrabold mt-1">{formatCurrency(balance)}</p>
        <div className="mt-4 pt-2 border-t border-indigo-500">
          <p className="text-xs opacity-75">Seu ID de Usuário (Para Receber)</p>
          <p className="font-mono text-sm break-all">{userId}</p>
        </div>
      </div>

      {/* Botões de Ação */}
      <div className="flex space-x-4">
        <button
          onClick={() => setView('transfer')}
          className="flex-1 py-3 px-4 bg-white border border-indigo-600 text-indigo-600 font-semibold rounded-lg shadow hover:bg-indigo-50 transition duration-150 ease-in-out flex items-center justify-center"
        >
            {/* SVG Icon for Transfer (Send) */}
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-2"><path d="M12 5V19"/><path d="m19 12-7 7-7-7"/></svg>
            Transferir
        </button>
        <button
          onClick={() => {
            clearMessages();
            // Abre o modal/input de depósito
            const depositAmount = window.prompt("Digite o valor para depósito (Ex: 50.00):");
            const amount = parseFloat(depositAmount?.replace(',', '.')) || 0;
            if (amount > 0) {
              handleDeposit(amount);
            } else if (depositAmount !== null && depositAmount !== "") {
              setError("Valor de depósito inválido.");
            }
          }}
          className="flex-1 py-3 px-4 bg-indigo-600 text-white font-semibold rounded-lg shadow hover:bg-indigo-700 transition duration-150 ease-in-out flex items-center justify-center"
        >
            {/* SVG Icon for Deposit (Receive/Add) */}
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-2"><circle cx="12" cy="12" r="10"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>
            Depositar
        </button>
      </div>

      <TransactionHistory />
    </div>
  );

  // Renderização principal do componente App
  return (
    <div className="min-h-screen bg-gray-100 flex items-start justify-center p-4 sm:p-8">
      <div className="w-full max-w-xl">
        <h1 className="text-3xl font-extrabold text-gray-900 mb-6 text-center">Carteira Digital (Sandbox)</h1>

        {/* Mensagens de Feedback */}
        {(error || message) && (
          <div className={`p-3 mb-4 rounded-lg text-sm font-medium ${error ? 'bg-red-100 text-red-700 border border-red-200' : 'bg-green-100 text-green-700 border border-green-200'}`}>
            {error || message}
          </div>
        )}

        {/* Seleção de View */}
        {view === 'home' && <HomeView />}
        {view === 'transfer' && <TransferView />}
      </div>
    </div>
  );
};

export default App;
