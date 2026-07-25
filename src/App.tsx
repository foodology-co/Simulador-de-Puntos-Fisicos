import React, { useState, useMemo, useEffect, createContext, useContext } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/src/components/ui/card';
import { Input } from '@/src/components/ui/input';
import { Building, DollarSign, Percent, Target, Plus, LayoutDashboard, Settings, Pencil, Save, Copy, Loader2, Share2, Check, GripVertical, Link as LinkIcon, Upload, BarChart2, MapPin, Map } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Scatter
} from 'recharts';
import { db } from './firebase';
import { doc, getDoc, setDoc, serverTimestamp, onSnapshot } from 'firebase/firestore';
import { handleFirestoreError, OperationType } from './lib/firebase-errors';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

type PNLParams = {
  ordersPerDay: number;
  ordersPerDaySept: number;
  avgTicketMxn: number;
  daysOpen: number;
  taxPercent: number;
  cancellationsPercent: number;
  cogsFoodPercent: number;
  deliveryAppOrdersPercent: number;
  deliveryAppCommRate: number;
  rentMxn: number;
  encargadoCount: number;
  encargadoCost: number;
  segundoCount: number;
  segundoCost: number;
  cocineroCount: number;
  cocineroCost: number;
  cajeroCount: number;
  cajeroCost: number;
  valetCount: number;
  valetCost: number;
  stewardCount: number;
  stewardCost: number;
  utilitiesPercent: number;
  marketingPercent: number;
  directMarketingPercent: number;
  otherFixedPercent: number;
  inventoryTransportationPercent?: number;
  totalInvestmentMxn: number;
};

type Simulation = {
  id: string;
  name: string;
  description?: string;
  params: PNLParams;
  country?: 'MX' | 'CO';
};

const DEFAULT_PARAMS: PNLParams = {
  ordersPerDay: 80,
  ordersPerDaySept: 70,
  avgTicketMxn: 300,
  daysOpen: 30,
  taxPercent: 16,
  cancellationsPercent: 2,
  cogsFoodPercent: 28,
  deliveryAppOrdersPercent: 80,
  deliveryAppCommRate: 20,
  rentMxn: 50000,
  encargadoCount: 1,
  encargadoCost: 16000,
  segundoCount: 1,
  segundoCost: 14000,
  cocineroCount: 2,
  cocineroCost: 13000,
  cajeroCount: 2,
  cajeroCost: 10000,
  valetCount: 0,
  valetCost: 8000,
  stewardCount: 0,
  stewardCost: 8000,
  utilitiesPercent: 5,
  marketingPercent: 3,
  directMarketingPercent: 1,
  otherFixedPercent: 2,
  totalInvestmentMxn: 500000,
};

const CO_DEFAULT_PARAMS: PNLParams = {
  ...DEFAULT_PARAMS,
  avgTicketMxn: 65000,
  rentMxn: 6000000,
  encargadoCount: 1,
  encargadoCost: 2000000,
  segundoCount: 1,
  segundoCost: 1600000,
  cocineroCount: 2,
  cocineroCost: 1500000,
  cajeroCount: 2,
  cajeroCost: 1300000,
  valetCount: 0,
  valetCost: 1200000,
  stewardCount: 0,
  stewardCost: 1200000,
  totalInvestmentMxn: 100000000,
  taxPercent: 8, // impoconsumo in CO usually
};

export const CountryContext = createContext<'MX' | 'CO'>('MX');

export function useCurrencyInfo() {
  const country = useContext(CountryContext);
  const isMX = country === 'MX';
  
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat(isMX ? 'es-MX' : 'es-CO', { 
      style: 'currency', 
      currency: isMX ? 'MXN' : 'COP', 
      maximumFractionDigits: 0 
    }).format(value);
  };

  const formatShortCurrency = (v: number) => {
    if (isMX) return `$${(v/1000).toFixed(0)}k`;
    return `$${(v/1000000).toFixed(1)}M`;
  };

  return { formatCurrency, formatShortCurrency, country, isMX };
}

function calculatePNL(params: PNLParams, locationName?: string) {
  const isQueretaro = locationName ? locationName.toLowerCase().includes('queretaro') : false;
  
  const totalSales = params.ordersPerDay * params.avgTicketMxn * params.daysOpen;
  const ivaDeduction = totalSales * (params.taxPercent / 100);
  const cancellations = (totalSales - ivaDeduction) * (params.cancellationsPercent / 100);
  const netSales = totalSales - ivaDeduction - cancellations;
  
  const foodCost = netSales * (params.cogsFoodPercent / 100);
  const deliveryCommPercent = (params.deliveryAppOrdersPercent / 100) * params.deliveryAppCommRate;
  const commisions = netSales * (deliveryCommPercent / 100);
  
  const totalCogsAndComms = commisions + foodCost;
  const contributionMargin = netSales - totalCogsAndComms;

  const utilitiesMxn = netSales * (params.utilitiesPercent / 100);
  const effectiveMarketingPercent = ((params.deliveryAppOrdersPercent / 100) * params.marketingPercent) + (((100 - params.deliveryAppOrdersPercent) / 100) * params.directMarketingPercent);
  const marketingMxn = netSales * (effectiveMarketingPercent / 100);
  const otherFixedMxn = netSales * (params.otherFixedPercent / 100);
  const inventoryTransportationMxn = netSales * ((params.inventoryTransportationPercent || 0) / 100);

  const valetCount = isQueretaro ? 0 : (params.valetCount || 0);
  const stewardCount = isQueretaro ? 0 : (params.stewardCount || 0);

  const laborMxn = (params.encargadoCount || 0) * (params.encargadoCost || 0) + (params.segundoCount || 0) * (params.segundoCost || 0) + (params.cocineroCount || 0) * (params.cocineroCost || 0) + (params.cajeroCount || 0) * (params.cajeroCost || 0) + valetCount * (params.valetCost || 0) + stewardCount * (params.stewardCost || 0);

  const totalFixedCosts = params.rentMxn + laborMxn + utilitiesMxn + otherFixedMxn + inventoryTransportationMxn;
  const grossMargin = contributionMargin - totalFixedCosts;

  const totalOpex = totalFixedCosts + marketingMxn;
  const operatingProfit = grossMargin - marketingMxn;
  const operatingProfitMargin = netSales > 0 ? (operatingProfit / netSales) : 0;
  
  return { rentMxn: params.rentMxn, totalSales, ivaDeduction, cancellations, netSales, foodCost, commisions, totalCogsAndComms, contributionMargin, utilitiesMxn, marketingMxn, otherFixedMxn, inventoryTransportationMxn, laborMxn, totalFixedCosts, grossMargin, totalOpex, operatingProfit, operatingProfitMargin, ebitda: operatingProfit, ebitdaMargin: operatingProfitMargin };
}

const SortableTab: React.FC<{ sim: Simulation, activeTab: string, onClick: () => void }> = ({ sim, activeTab, onClick }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sim.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-1 px-4 py-2 rounded-md text-sm font-medium transition-colors shrink-0 min-w-32",
        activeTab === sim.id ? "bg-fdgy-cream/50 text-fdgy-navy border border-fdgy-cream shadow-sm" : "bg-white text-fdgy-navy/80 border border-transparent hover:border-fdgy-cream/50 hover:bg-white/50",
        isDragging && "opacity-50 shadow-lg"
      )}
    >
      <div {...attributes} {...listeners} className="cursor-grab hover:bg-black/5 p-1 rounded -ml-2 mr-1">
        <GripVertical className="w-4 h-4 text-fdgy-navy/40" />
      </div>
      <button onClick={onClick} className="flex items-center gap-2 flex-1 text-left select-none outline-none">
        <Settings className={cn("w-3.5 h-3.5", activeTab !== sim.id && "opacity-50")} />
        {sim.name}
      </button>
    </div>
  );
}

import Papa from 'papaparse';
import { rawLocalesCSV } from './data/localesRawData';

function useQualitativeData() {
  const [data, setData] = useState<any[]>([]);

  useEffect(() => {
    Papa.parse(rawLocalesCSV, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const parsedData = results.data.map((row: any) => {
          // Clean data
          const rentaTotalStr = row['RENTA TOTAL'] || '0';
          const rentaM2Str = row['RENTA/M2'] || '0';
          
          const rentaTotal = parseFloat(rentaTotalStr.replace(/[\$,]/g, '')) || 0;
          const rentaM2 = parseFloat(rentaM2Str.replace(/[\$,]/g, '')) || 0;
          const calificacion = parseFloat(row['CALIFICACIÓN'] || '0') || 0;
          const m2 = parseFloat((row['M2'] || '0').split(' ')[0].split('/')[0]) || 0;
          
          return {
            ...row,
            rentaTotalNumeric: rentaTotal,
            rentaM2Numeric: rentaM2,
            calificacionNumeric: calificacion,
            m2Numeric: m2,
            nombre: row['LOCAL']
          };
        }).filter(r => r.nombre);
        setData(parsedData);
      }
    });
  }, []);

  return data;
}

export default function App() {
  const [simulations, setSimulations] = useState<Simulation[]>([]);
  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const qualitativeData = useQualitativeData();
  const [activeCountry, setActiveCountry] = useState<'MX' | 'CO'>('MX');
  const [isSaving, setIsSaving] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const [scenarioId, setScenarioId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('scenario'));
  const isRemoteUpdate = React.useRef(false);

  useEffect(() => {
    if (scenarioId) {
      const docRef = doc(db, 'scenarios', scenarioId);
      const unsubscribe = onSnapshot(docRef, (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data.simulations) {
            setSimulations(prev => {
              const remoteStr = JSON.stringify(data.simulations);
              const localStr = JSON.stringify(prev);
              if (remoteStr !== localStr) {
                isRemoteUpdate.current = true;
                return data.simulations;
              }
              return prev;
            });
            setIsLoading(false);
          }
        } else {
           setIsLoading(false);
        }
      }, (error) => {
        handleFirestoreError(error, OperationType.GET, `scenarios/${scenarioId}`);
      });
      return () => unsubscribe();
    } else {
      // Fallback to local storage
      let saved = null;
      try {
        saved = localStorage.getItem('foodology-simulations');
      } catch (err) {
        console.warn('localStorage is not accessible:', err);
      }
      
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          setSimulations(parsed.map((sim: any) => ({
            ...sim,
            country: sim.country || 'MX',
            params: { ...DEFAULT_PARAMS, ...sim.params }
          })));
        } catch (e) {
          console.error("Error parsing saved simulations", e);
          setSimulations([
            { id: '1', name: 'Cocina A', country: 'MX', params: { ...DEFAULT_PARAMS } },
            { id: '2', name: 'Cocina B', country: 'MX', params: { ...DEFAULT_PARAMS, ordersPerDay: 120, rentMxn: 60000 } },
            { id: '3', name: 'Cocina C', country: 'CO', params: { ...CO_DEFAULT_PARAMS } }
          ]);
        }
      } else {
        setSimulations([
          { id: '1', name: 'Cocina A', country: 'MX', params: { ...DEFAULT_PARAMS } },
          { id: '2', name: 'Cocina B', country: 'MX', params: { ...DEFAULT_PARAMS, ordersPerDay: 120, rentMxn: 60000 } },
          { id: '3', name: 'Cocina C', country: 'CO', params: { ...CO_DEFAULT_PARAMS } }
        ]);
      }
      setIsLoading(false);
    }
  }, [scenarioId]);

  useEffect(() => {
    const toDelete = ["plaza carso", "corporativo dos patios", "montes urales", "cocina f", "corporativo dos patios (polanco)", "calle montes urales (lomas)", "queretaro 1", "queretaro 2", "queretaro-1", "queretaro-2"];
    if (simulations.some(s => toDelete.includes(s.name.trim().toLowerCase()))) {
      setSimulations(sims => sims.filter(s => !toDelete.includes(s.name.trim().toLowerCase())));
    }
  }, [simulations]);

  // Restore specific branches one-time if missing
  useEffect(() => {
    if (!isLoading && simulations.length > 0) {
      let toAdd: Simulation[] = [];
      const simNames = simulations.map(s => s.name.toLowerCase());
      
      if (!simNames.includes('amsterdam') && !simNames.includes('amsterdam condesa')) {
        toAdd.push({
          id: 'amsterdam-restored-' + Date.now(),
          name: 'Amsterdam',
          country: 'MX',
          params: { ...DEFAULT_PARAMS, totalInvestmentMxn: 500000, segundoCost: 21713, encargadoCost: 30528, cajeroCount: 5, directMarketingPercent: 7, ordersPerDay: 150, otherFixedPercent: 3, deliveryAppOrdersPercent: 50, segundoCount: 1, cajeroCost: 20093, taxPercent: 16, daysOpen: 30, valetCost: 22000, cocineroCount: 3, utilitiesPercent: 4, valetCount: 1, cocineroCost: 18658, stewardCount: 1, deliveryAppCommRate: 20, ordersPerDaySept: 75, rentMxn: 125000, marketingPercent: 10, stewardCost: 11284, encargadoCount: 2, cancellationsPercent: 0.5, avgTicketMxn: 350, cogsFoodPercent: 26 }
        });
      }
      if (!simNames.includes('narvarte')) {
        toAdd.push({
          id: 'narvarte-restored-' + Date.now(),
          name: 'Narvarte',
          country: 'MX',
          params: { ...DEFAULT_PARAMS, cajeroCount: 3, ordersPerDay: 135, otherFixedPercent: 3, directMarketingPercent: 2, deliveryAppOrdersPercent: 80, segundoCount: 1, taxPercent: 16, cajeroCost: 20093, daysOpen: 30, cocineroCount: 5, valetCost: 8000, segundoCost: 21713, totalInvestmentMxn: 500000, encargadoCost: 23414, deliveryAppCommRate: 20, rentMxn: 55000, ordersPerDaySept: 58, marketingPercent: 12, cancellationsPercent: 0.5, encargadoCount: 1, stewardCost: 8000, avgTicketMxn: 250, cogsFoodPercent: 28, utilitiesPercent: 4, valetCount: 0, cocineroCost: 18658, stewardCount: 0 }
        });
      }
      if (!simNames.includes('cumbres')) {
        toAdd.push({
          id: 'cumbres-restored-' + Date.now(),
          name: 'Cumbres',
          country: 'MX',
          params: { ...DEFAULT_PARAMS, ordersPerDaySept: 70, rentMxn: 50000, deliveryAppCommRate: 20, cogsFoodPercent: 28, avgTicketMxn: 300, stewardCost: 8000, encargadoCount: 1, cancellationsPercent: 2, marketingPercent: 3, utilitiesPercent: 5, valetCount: 0, stewardCount: 0, cocineroCost: 13000, deliveryAppOrdersPercent: 80, directMarketingPercent: 1, otherFixedPercent: 2, ordersPerDay: 80, cajeroCount: 2, cocineroCount: 2, valetCost: 8000, daysOpen: 30, cajeroCost: 10000, taxPercent: 16, segundoCount: 1, encargadoCost: 16000, segundoCost: 14000, totalInvestmentMxn: 500000 }
        });
      }
      if (!simNames.includes('cielo abierto') && !simNames.includes('cielo abierto coyoacan')) {
        toAdd.push({
          id: 'cielo-abierto-restored-' + Date.now(),
          name: 'Cielo Abierto',
          country: 'MX',
          params: { ...DEFAULT_PARAMS, cajeroCount: 2, otherFixedPercent: 2, ordersPerDay: 80, directMarketingPercent: 1, deliveryAppOrdersPercent: 80, segundoCount: 1, taxPercent: 16, cajeroCost: 10000, daysOpen: 30, valetCost: 8000, cocineroCount: 2, segundoCost: 14000, totalInvestmentMxn: 500000, encargadoCost: 16000, deliveryAppCommRate: 20, rentMxn: 50000, ordersPerDaySept: 70, marketingPercent: 3, cancellationsPercent: 2, stewardCost: 8000, encargadoCount: 1, avgTicketMxn: 300, cogsFoodPercent: 28, utilitiesPercent: 5, valetCount: 0, cocineroCost: 13000, stewardCount: 0 }
        });
      }
      
      if (toAdd.length > 0) {
        setSimulations(sims => [...sims, ...toAdd]);
      }
    }
  }, [isLoading]);

  useEffect(() => {
    if (simulations.length > 0) {
      if (isRemoteUpdate.current) {
        isRemoteUpdate.current = false;
        return;
      }
      
      if (scenarioId) {
        const timer = setTimeout(() => {
          setDoc(doc(db, 'scenarios', scenarioId), {
            simulations,
            updatedAt: serverTimestamp()
          }, { merge: true }).catch((error) => {
             handleFirestoreError(error, OperationType.UPDATE, `scenarios/${scenarioId}`);
          });
        }, 500);
        return () => clearTimeout(timer);
      } else {
        try {
          localStorage.setItem('foodology-simulations', JSON.stringify(simulations));
        } catch (e) {
          console.error("Could not save to localStorage", e);
        }
      }
    }
  }, [simulations, scenarioId]);

  const handleShare = async () => {
    if (scenarioId) {
      let hostUrl = window.location.origin;
      if (hostUrl.includes('ais-dev-')) {
        hostUrl = hostUrl.replace('ais-dev-', 'ais-pre-');
      }
      const newUrl = `${hostUrl}${window.location.pathname}?scenario=${scenarioId}`;
      setShareUrl(newUrl);
      try {
        await navigator.clipboard.writeText(newUrl);
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
      } catch (err) {
        console.error("Failed to copy automatically", err);
      }
      return;
    }

    setIsSaving(true);
    try {
      const newScenarioId = Math.random().toString(36).substring(2, 15);
      await setDoc(doc(db, 'scenarios', newScenarioId), {
        simulations,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      
      setScenarioId(newScenarioId);
      
      let hostUrl = window.location.origin;
      if (hostUrl.includes('ais-dev-')) {
        hostUrl = hostUrl.replace('ais-dev-', 'ais-pre-');
      }
      const newUrl = `${hostUrl}${window.location.pathname}?scenario=${newScenarioId}`;
      window.history.pushState({path: newUrl}, '', window.location.href);
      
      setShareUrl(newUrl);
      try {
        await navigator.clipboard.writeText(newUrl);
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
      } catch (err) {
        console.error("Failed to copy automatically", err);
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'scenarios');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setSimulations((items) => {
        const oldIndex = items.findIndex((i) => i.id === active.id);
        const newIndex = items.findIndex((i) => i.id === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  const filteredSims = useMemo(() => simulations.filter(s => (s.country || 'MX') === activeCountry), [simulations, activeCountry]);

  const addSimulation = () => {
    const newId = Date.now().toString();
    
    let nextIndex = filteredSims.length;
    let nextChar = String.fromCharCode(65 + nextIndex);
    while (nextChar === 'F' || simulations.some(s => s.name === `Cocina ${nextChar}`)) {
      nextIndex++;
      nextChar = String.fromCharCode(65 + nextIndex);
    }

    setSimulations([...simulations, {
      id: newId,
      name: `Cocina ${nextChar}`,
      country: activeCountry,
      params: activeCountry === 'CO' ? { ...CO_DEFAULT_PARAMS } : { ...DEFAULT_PARAMS }
    }]);
    setActiveTab(newId);
  };

  const updateSimulation = (simId: string, updates: Partial<Simulation>) => {
    setSimulations(sims => sims.map(s => s.id === simId ? { ...s, ...updates } : s));
  };

  const activeSimulation = simulations.find(s => s.id === activeTab);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#FDFBF7] text-fdgy-navy flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-fdgy-navy/50" />
      </div>
    );
  }

  return (
    <CountryContext.Provider value={activeCountry}>
      <div className="min-h-screen bg-[#FDFBF7] text-fdgy-navy font-sans flex flex-col overflow-x-hidden">
        <header className="h-16 bg-fdgy-navy border-none flex items-center justify-between px-4 md:px-8 shrink-0 sticky top-0 z-10 w-full">
          <div className="flex items-center gap-3 w-full max-w-7xl mx-auto justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center font-bold text-white shrink-0">
                <Building className="w-4 h-4" />
              </div>
              <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-white flex items-baseline">
                foodology<span className="text-fdgy-pink font-black">.</span> 
                <span className="hidden sm:inline-block text-white/60 font-medium text-base sm:text-lg ml-3 tracking-normal">| P&L Simulator</span>
                {scenarioId && (
                  <span className="hidden md:flex ml-3 items-center gap-1.5 px-2 py-0.5 rounded-full bg-fdgy-green/20 border border-fdgy-green/40 text-[10px] uppercase font-bold tracking-widest text-fdgy-green">
                    <span className="w-1.5 h-1.5 rounded-full bg-fdgy-green animate-pulse"></span>
                    Live Sincronizado
                  </span>
                )}
              </h1>
            </div>

            <div className="flex items-center gap-3">
              <div className="bg-white/10 rounded-lg flex p-1">
                <button
                  onClick={() => { setActiveCountry('MX'); setActiveTab('dashboard'); }}
                  className={cn("px-3 py-1.5 text-sm font-bold rounded-md transition-colors flex items-center gap-2", activeCountry === 'MX' ? "bg-white text-fdgy-navy" : "text-white/60 hover:text-white")}
                >
                  🇲🇽 México
                </button>
                <button
                  onClick={() => { setActiveCountry('CO'); setActiveTab('dashboard'); }}
                  className={cn("px-3 py-1.5 text-sm font-bold rounded-md transition-colors flex items-center gap-2", activeCountry === 'CO' ? "bg-white text-fdgy-navy" : "text-white/60 hover:text-white")}
                >
                  🇨🇴 Colombia
                </button>
              </div>
              
              <button
                onClick={handleShare}
                disabled={isSaving}
                className="flex items-center gap-2 bg-white/10 hover:bg-white/20 transition-colors text-white px-3 sm:px-4 py-2 rounded-lg font-bold text-sm"
              >
                {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : (isCopied ? <Check className="w-4 h-4" /> : (scenarioId ? <Share2 className="w-4 h-4" /> : <Save className="w-4 h-4" />))}
                <span className="hidden sm:inline">{isCopied ? 'Link Copiado' : (isSaving ? 'Generando...' : (scenarioId ? 'Compartir Escenario (Live)' : 'Crear Escenario Compartido'))}</span>
              </button>
            </div>
          </div>
        </header>

        {shareUrl && (
          <div className="bg-fdgy-cream/50 text-fdgy-navy border-b border-fdgy-cream/60 py-2 px-4 md:px-8 text-sm flex items-center justify-between">
            <div className="flex items-center gap-2">
              <LinkIcon className="h-4 w-4" />
              <span className="font-semibold">Comparte este link:</span>
              <input 
                readOnly 
                value={shareUrl} 
                className="bg-white/50 border border-fdgy-navy/10 rounded px-2 py-0.5 text-fdgy-navy flex-1 min-w-[250px] font-mono text-xs select-all outline-none focus:ring-2 ring-fdgy-navy/20"
                onClick={(e) => e.currentTarget.select()}
              />
            </div>
            <button 
              onClick={() => {
                navigator.clipboard.writeText(shareUrl);
                setIsCopied(true);
                setTimeout(() => setIsCopied(false), 2000);
              }} 
              className="flex items-center gap-1 text-xs font-bold hover:opacity-70"
            >
              {isCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {isCopied ? "Copiado" : "Copiar"}
            </button>
          </div>
        )}

        <div className="bg-fdgy-cream/20 border-b border-fdgy-cream/50 px-4 md:px-6 py-3 overflow-x-auto scrollbar-hide" style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
          <div className="flex items-center gap-2 max-w-7xl mx-auto">
            <button
              onClick={() => setActiveTab('dashboard')}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors shrink-0",
                activeTab === 'dashboard' ? "bg-fdgy-navy text-white shadow-sm" : "text-fdgy-navy/70 hover:text-fdgy-navy hover:bg-fdgy-cream/30"
              )}
            >
              <LayoutDashboard className="w-4 h-4" />
              Dashboard Principal
            </button>
            <button
              onClick={() => setActiveTab('qualitative')}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors shrink-0",
                activeTab === 'qualitative' ? "bg-fdgy-navy text-white shadow-sm" : "text-fdgy-navy/70 hover:text-fdgy-navy hover:bg-fdgy-cream/30"
              )}
            >
              <BarChart2 className="w-4 h-4" />
              Dashboard Cualitativo
            </button>
            <button
              onClick={() => setActiveTab('dashboard_queretaro')}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors shrink-0",
                activeTab === 'dashboard_queretaro' ? "bg-fdgy-navy text-white shadow-sm" : "text-fdgy-navy/70 hover:text-fdgy-navy hover:bg-fdgy-cream/30"
              )}
            >
              <LayoutDashboard className="w-4 h-4" />
              Consolidado Queretaro
            </button>
            
            <div className="w-px h-6 bg-fdgy-cream/60 mx-2 flex-shrink-0"></div>

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={filteredSims.map(s => s.id)} strategy={horizontalListSortingStrategy}>
                {filteredSims.map(sim => (
                  <SortableTab key={sim.id} sim={sim} activeTab={activeTab} onClick={() => setActiveTab(sim.id)} />
                ))}
              </SortableContext>
            </DndContext>
            
            <button
              onClick={addSimulation}
              className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-fdgy-navy bg-white/50 border border-dashed border-fdgy-navy/30 rounded-md hover:bg-fdgy-cream/30 transition-colors shrink-0"
            >
              <Plus className="w-4 h-4" />
              Nueva Apertura
            </button>
          </div>
        </div>

        <main className="flex-1 p-4 md:p-6 w-full max-w-7xl mx-auto space-y-6">
          {activeTab === 'dashboard' ? (
            <DashboardView simulations={filteredSims.filter(s => {
              const name = s.name.toLowerCase();
              return !name.includes('cumbres') && !name.includes('cielo abierto') && !name.includes('interlomas') && !name.includes('queretaro');
            })} />
          ) : activeTab === 'dashboard_queretaro' ? (
            <DashboardView 
              simulations={filteredSims.filter(s => s.name.toLowerCase().includes('queretaro'))} 
              title="Consolidado Queretaro"
              subtitle="Resumen de P&L de las aperturas en la ciudad de Queretaro"
              isDetailed={true}
            />
          ) : activeTab === 'qualitative' ? (
            <QualitativeDashboardView data={qualitativeData} />
          ) : activeSimulation ? (
            <PNLCalculatorView 
              sim={activeSimulation} 
              onChange={(updates) => updateSimulation(activeSimulation.id, updates)}
              qualitativeData={qualitativeData}
            />
          ) : null}
        </main>
      </div>
    </CountryContext.Provider>
  );
}

function QualitativeDashboardView({ data }: { data: any[] }) {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedLocal, setSelectedLocal] = useState<any | null>(null);
  const [sortConfig, setSortConfig] = useState<{key: string, direction: 'asc' | 'desc'} | null>(null);

  const filteredData = useMemo(() => {
    let result = data.filter(d => d.nombre.toLowerCase().includes(searchTerm.toLowerCase()) || 
                            (d['UBICACIÓN'] && d['UBICACIÓN'].toLowerCase().includes(searchTerm.toLowerCase())));
                            
    if (sortConfig !== null) {
      result.sort((a, b) => {
        let aVal = a[sortConfig.key];
        let bVal = b[sortConfig.key];
        
        // Handle undefined or null
        if (aVal === undefined || aVal === null) aVal = "";
        if (bVal === undefined || bVal === null) bVal = "";

        if (aVal < bVal) {
          return sortConfig.direction === 'asc' ? -1 : 1;
        }
        if (aVal > bVal) {
          return sortConfig.direction === 'asc' ? 1 : -1;
        }
        return 0;
      });
    }
    return result;
  }, [data, searchTerm, sortConfig]);

  const requestSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const chartData = useMemo(() => {
    return filteredData
      .filter(d => d.calificacionNumeric > 0)
      .sort((a, b) => b.calificacionNumeric - a.calificacionNumeric)
      .slice(0, 15);
  }, [filteredData]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-fdgy-navy/60 uppercase">Locales Evaluados</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-fdgy-navy">{data.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-fdgy-navy/60 uppercase">Renta Promedio / m²</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-fdgy-navy">
              ${Math.round(data.reduce((acc, curr) => acc + (curr.rentaM2Numeric || 0), 0) / (data.filter(d => d.rentaM2Numeric > 0).length || 1)).toLocaleString('es-MX')}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-fdgy-navy/60 uppercase">Aprobados para Visita</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-fdgy-navy">
              {data.filter(d => d['APLICA A VISITA']?.toUpperCase() === 'SI').length}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Top Locales por Calificación</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-80 pt-4">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="#E8D2AE" strokeOpacity={0.5} />
                  <XAxis type="number" domain={[0, 5]} hide />
                  <YAxis dataKey="nombre" type="category" width={150} tick={{fill: '#14225B', fontSize: 10}} axisLine={false} tickLine={false} />
                  <Tooltip 
                    contentStyle={{ borderRadius: '8px', border: '1px solid #E8D2AE', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                  />
                  <Bar 
                    dataKey="calificacionNumeric" 
                    fill="#14225B" 
                    name="Calificación" 
                    radius={[0, 4, 4, 0]}
                    className="cursor-pointer"
                    onClick={(data) => {
                      const local = data?.payload || data;
                      setSelectedLocal(local);
                      setSearchTerm(local?.nombre || '');
                    }}
                  >
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.calificacionNumeric >= 4 ? '#6D8A65' : '#14225B'} />
                    ))}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Renta/m² vs Calificación</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-80 pt-4">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={data.filter(d => d.rentaM2Numeric > 0 && d.calificacionNumeric > 0)} margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E8D2AE" strokeOpacity={0.5} />
                  <XAxis 
                    dataKey="calificacionNumeric" 
                    type="number" 
                    name="Calificación" 
                    domain={[0, 5]} 
                    tick={{fill: '#14225B'}} 
                    label={{ value: 'Calificación', position: 'insideBottom', offset: -10, fill: '#14225B' }}
                  />
                  <YAxis 
                    dataKey="rentaM2Numeric" 
                    type="number" 
                    name="Renta/m2"
                    tick={{fill: '#14225B'}}
                    label={{ value: 'Renta / m²', angle: -90, position: 'insideLeft', fill: '#14225B' }}
                  />
                  <Tooltip cursor={{strokeDasharray: '3 3'}} contentStyle={{ borderRadius: '8px', border: '1px solid #E8D2AE', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                  <Scatter 
                    name="Locales" 
                    dataKey="rentaM2Numeric" 
                    fill="#DF99B9" 
                    className="cursor-pointer"
                    onClick={(data) => {
                      const local = data?.payload || data;
                      setSelectedLocal(local);
                      setSearchTerm(local?.nombre || '');
                    }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <CardTitle>Detalle de Locales Evaluados</CardTitle>
          <Input 
            placeholder="Buscar por local o ubicación..." 
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full sm:max-w-xs"
          />
        </CardHeader>
        <CardContent className="overflow-x-auto p-0 sm:p-6">
          <table className="w-full text-sm text-left min-w-[800px]">
            <thead className="bg-fdgy-cream/20 text-fdgy-navy/80 text-[10px] uppercase font-bold tracking-wider">
               <tr>
                 <th className="px-4 py-3 rounded-tl-md cursor-pointer hover:bg-fdgy-cream/40" onClick={() => requestSort('nombre')}>
                   Local {sortConfig?.key === 'nombre' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                 </th>
                 <th className="px-4 py-3 cursor-pointer hover:bg-fdgy-cream/40" onClick={() => requestSort('TRÁFICO')}>
                   Ubicación / Entorno {sortConfig?.key === 'TRÁFICO' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                 </th>
                 <th className="px-4 py-3 text-right cursor-pointer hover:bg-fdgy-cream/40" onClick={() => requestSort('m2Numeric')}>
                   m² {sortConfig?.key === 'm2Numeric' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                 </th>
                 <th className="px-4 py-3 text-right cursor-pointer hover:bg-fdgy-cream/40" onClick={() => requestSort('rentaTotalNumeric')}>
                   Renta Total {sortConfig?.key === 'rentaTotalNumeric' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                 </th>
                 <th className="px-4 py-3 text-right cursor-pointer hover:bg-fdgy-cream/40" onClick={() => requestSort('rentaM2Numeric')}>
                   Renta/m² {sortConfig?.key === 'rentaM2Numeric' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                 </th>
                 <th className="px-4 py-3 text-right cursor-pointer hover:bg-fdgy-cream/40" onClick={() => requestSort('calificacionNumeric')}>
                   Calificación {sortConfig?.key === 'calificacionNumeric' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                 </th>
                 <th className="px-4 py-3 text-center rounded-tr-md cursor-pointer hover:bg-fdgy-cream/40" onClick={() => requestSort('APLICA A VISITA')}>
                   Visita {sortConfig?.key === 'APLICA A VISITA' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                 </th>
               </tr>
            </thead>
            <tbody className="divide-y divide-fdgy-cream/30">
               {filteredData.map((d, i) => (
                 <tr key={i} className="hover:bg-fdgy-cream/20 transition-colors cursor-pointer" onClick={() => setSelectedLocal(d)}>
                   <td className="px-4 py-3 font-medium text-fdgy-navy flex items-center gap-2">
                     {d.nombre}
                     <a 
                       href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.nombre + ', CDMX, Mexico')}`} 
                       target="_blank" 
                       rel="noopener noreferrer"
                       className="text-fdgy-navy/40 hover:text-fdgy-pink transition-colors"
                       onClick={(e) => e.stopPropagation()}
                     >
                       <MapPin className="w-3.5 h-3.5" />
                     </a>
                   </td>
                   <td className="px-4 py-3 text-fdgy-navy/70 text-xs max-w-[200px] truncate" title={d['TRÁFICO']}>{d['TRÁFICO'] || '-'}</td>
                   <td className="px-4 py-3 text-right text-fdgy-navy/80">{d['M2']}</td>
                   <td className="px-4 py-3 text-right text-fdgy-navy/80">{d['RENTA TOTAL'] ? d['RENTA TOTAL'] : '-'}</td>
                   <td className="px-4 py-3 text-right text-fdgy-navy/80">{d['RENTA/M2'] ? d['RENTA/M2'] : '-'}</td>
                   <td className="px-4 py-3 text-right font-bold text-fdgy-navy/90">{d['CALIFICACIÓN'] || '-'}</td>
                   <td className="px-4 py-3 text-center">
                     {d['APLICA A VISITA']?.toUpperCase() === 'SI' ? (
                       <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-fdgy-green/20 text-fdgy-green">SI</span>
                     ) : d['APLICA A VISITA']?.toUpperCase() === 'NO' ? (
                       <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-fdgy-pink/20 text-fdgy-pink">NO</span>
                     ) : (
                       <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800">-</span>
                     )}
                   </td>
                 </tr>
               ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {selectedLocal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-fdgy-navy/80 backdrop-blur-sm" onClick={() => setSelectedLocal(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 bg-white border-b border-fdgy-cream px-6 py-4 flex items-center justify-between z-10">
              <div className="flex items-center gap-3">
                <h3 className="text-xl font-bold text-fdgy-navy">{selectedLocal.nombre}</h3>
                <a 
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(selectedLocal.nombre + ', CDMX, Mexico')}`} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="bg-fdgy-cream/30 hover:bg-fdgy-cream/50 text-fdgy-navy font-medium text-xs px-2 py-1 rounded flex items-center gap-1 transition-colors"
                >
                  <MapPin className="w-3.5 h-3.5" /> Abrir Maps
                </a>
              </div>
              <button 
                onClick={() => setSelectedLocal(null)}
                className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-fdgy-cream/50 text-fdgy-navy transition-colors shrink-0"
              >
                &times;
              </button>
            </div>
            <div className="p-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                {Object.entries(selectedLocal).filter(([key]) => key !== 'nombre' && !key.endsWith('Numeric') && selectedLocal[key]).map(([key, value]) => (
                  <div key={key}>
                    <label className="text-xs font-bold text-fdgy-navy/60 uppercase tracking-widest">{key}</label>
                    <p className="text-sm text-fdgy-navy font-medium mt-1 whitespace-pre-wrap">{String(value)}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DashboardView({ simulations, title = "Dashboard Agrupado", subtitle = "Resumen y comparación del P&L de todas las aperturas proyectadas.", isDetailed = false }: { simulations: Simulation[], title?: string, subtitle?: string, isDetailed?: boolean }) {
  const { formatCurrency, formatShortCurrency } = useCurrencyInfo();
  const [sortConfig, setSortConfig] = useState<{key: string, direction: 'asc' | 'desc'} | null>(null);
  
  const dashboardSimulations = useMemo(() => {
    return simulations;
  }, [simulations]);

  const chartData = useMemo(() => {
    let result = dashboardSimulations.map(sim => {
      const results = calculatePNL(sim.params);
      return {
        name: sim.name,
        Sales: results.netSales,
        EBITDA: results.ebitda,
        Margin: results.ebitdaMargin,
        GrossSales: results.totalSales,
        OrdersDay: sim.params.ordersPerDay,
        Payback: results.ebitda > 0 ? (sim.params.totalInvestmentMxn / results.ebitda) : null
      };
    });

    if (sortConfig !== null) {
      result.sort((a, b) => {
        let aVal = a[sortConfig.key as keyof typeof a];
        let bVal = b[sortConfig.key as keyof typeof b];

        if (aVal === null) aVal = -Infinity as any;
        if (bVal === null) bVal = -Infinity as any;

        if (aVal < bVal) {
          return sortConfig.direction === 'asc' ? -1 : 1;
        }
        if (aVal > bVal) {
          return sortConfig.direction === 'asc' ? 1 : -1;
        }
        return 0;
      });
    }

    return result;
  }, [dashboardSimulations, sortConfig]);

  const requestSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  const totalEbitda = chartData.reduce((acc, curr) => acc + curr.EBITDA, 0);
  const totalSales = chartData.reduce((acc, curr) => acc + curr.Sales, 0);

  const multiScenarioData = useMemo(() => {
    let totalBE: any = { Sales: 0, EBITDA: 0, orders: 0 };
    let totalSep: any = { Sales: 0, EBITDA: 0, orders: 0 };
    let totalDic: any = { Sales: 0, EBITDA: 0, orders: 0 };

    const accumulate = (target: any, source: any) => {
      Object.keys(source).forEach(key => {
        if (typeof source[key] === 'number') {
          target[key] = (target[key] || 0) + source[key];
        }
      });
    };

    const rows = dashboardSimulations.map(sim => {
      const p = sim.params;
      
      const f = (p.deliveryAppOrdersPercent / 100) * (p.deliveryAppCommRate / 100);
      const d = p.cogsFoodPercent / 100;
      const t = p.taxPercent / 100;
      const c = p.cancellationsPercent / 100;
      const u = p.utilitiesPercent / 100;
      const m = ((p.deliveryAppOrdersPercent / 100) * p.marketingPercent / 100) + (((100 - p.deliveryAppOrdersPercent) / 100) * p.directMarketingPercent / 100);
      const o = p.otherFixedPercent / 100;
      const it = (p.inventoryTransportationPercent || 0) / 100;

      const isQueretaro = sim.name.toLowerCase().includes('queretaro');
      const valetCount = isQueretaro ? 0 : (p.valetCount || 0);
      const stewardCount = isQueretaro ? 0 : (p.stewardCount || 0);

      const fixedCosts = p.rentMxn + ((p.encargadoCount || 0) * (p.encargadoCost || 0) + (p.segundoCount || 0) * (p.segundoCost || 0) + (p.cocineroCount || 0) * (p.cocineroCost || 0) + (p.cajeroCount || 0) * (p.cajeroCost || 0) + valetCount * (p.valetCost || 0) + stewardCount * (p.stewardCost || 0));
      const n = (1 - t) * (1 - c);
      const marginRatio = n * (1 - f - d - u - m - o - it);
      
      let breakEvenOrdersDaily = 0;
      if (marginRatio > 0) {
        const breakEvenGMV = fixedCosts / marginRatio;
        breakEvenOrdersDaily = Math.ceil(breakEvenGMV / p.avgTicketMxn / p.daysOpen);
      }

      const beResults = calculatePNL({ ...p, ordersPerDay: breakEvenOrdersDaily }, sim.name);
      const sepResults = calculatePNL({ ...p, ordersPerDay: p.ordersPerDaySept ?? (p.ordersPerDay * 0.8) }, sim.name);
      const dicResults = calculatePNL(p, sim.name);

      totalBE.Sales += beResults.netSales;
      totalBE.EBITDA += beResults.ebitda;
      totalBE.orders += breakEvenOrdersDaily;
      accumulate(totalBE, beResults);
      
      totalSep.Sales += sepResults.netSales;
      totalSep.EBITDA += sepResults.ebitda;
      totalSep.orders += p.ordersPerDaySept ?? (p.ordersPerDay * 0.8);
      accumulate(totalSep, sepResults);
      
      totalDic.Sales += dicResults.netSales;
      totalDic.EBITDA += dicResults.ebitda;
      totalDic.orders += p.ordersPerDay;
      accumulate(totalDic, dicResults);

      return {
        name: sim.name,
        be: beResults,
        beOrders: breakEvenOrdersDaily,
        sep: sepResults,
        sepOrders: p.ordersPerDaySept ?? (p.ordersPerDay * 0.8),
        dic: dicResults,
        dicOrders: p.ordersPerDay
      };
    });

    return { rows, totalBE, totalSep, totalDic };
  }, [dashboardSimulations]);

  const pieData = useMemo(() => {
    return dashboardSimulations.map(sim => {
      const p = sim.params;
      const results = calculatePNL(p, sim.name);
      
      const isQueretaro = sim.name.toLowerCase().includes('queretaro');
      const valetCount = isQueretaro ? 0 : (p.valetCount || 0);
      const stewardCount = isQueretaro ? 0 : (p.stewardCount || 0);

      const totalStaff = (p.encargadoCount || 0) + (p.segundoCount || 0) + (p.cocineroCount || 0) + (p.cajeroCount || 0) + valetCount + stewardCount;
      const totalLaborCost = (p.encargadoCount || 0) * (p.encargadoCost || 0) + 
                             (p.segundoCount || 0) * (p.segundoCost || 0) + 
                             (p.cocineroCount || 0) * (p.cocineroCost || 0) + 
                             (p.cajeroCount || 0) * (p.cajeroCost || 0) +
                             valetCount * (p.valetCost || 0) +
                             stewardCount * (p.stewardCost || 0);
      return {
        name: sim.name,
        totalStaff,
        totalLaborCost,
        laborCostPercent: results.netSales > 0 ? (totalLaborCost / results.netSales) : 0
      };
    });
  }, [dashboardSimulations]);

  const COLORS = ['#14225B', '#DF99B9', '#6D8A65', '#E8D2AE', '#A0C4E2', '#F2A65A', '#8B6B9E', '#E57373'];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-fdgy-navy">{title}</h2>
        <p className="text-sm text-fdgy-navy/60">{subtitle}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white p-6 rounded-2xl border border-fdgy-cream text-fdgy-navy shadow-sm flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-fdgy-navy/60 mb-1">Ventas Netas Totales Proyectadas</p>
            <h4 className="text-3xl font-bold text-fdgy-navy">{formatCurrency(totalSales)}</h4>
          </div>
          <div className="w-12 h-12 bg-fdgy-cream/30 rounded-xl flex items-center justify-center">
            <DollarSign className="text-fdgy-navy w-6 h-6" />
          </div>
        </div>
        <div className="bg-white p-6 rounded-2xl border border-fdgy-cream text-fdgy-navy shadow-sm flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-fdgy-navy/60 mb-1">EBITDA Total Proyectado</p>
            <h4 className="text-3xl font-bold text-fdgy-navy">{formatCurrency(totalEbitda)}</h4>
          </div>
          <div className="w-12 h-12 bg-fdgy-pink/20 rounded-xl flex items-center justify-center">
             <Target className="text-fdgy-navy w-6 h-6" />
          </div>
        </div>
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="bg-fdgy-navy/5 border-b border-fdgy-cream/50 pb-4">
          <CardTitle className="text-fdgy-navy text-lg">Escenarios Totalizados por Punto de Venta</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm text-left whitespace-nowrap">
            <thead className="bg-white text-[10px] uppercase tracking-wider font-bold text-fdgy-navy/50">
              <tr>
                <th className="px-4 py-3 border-b border-fdgy-cream/50">Punto de Venta</th>
                <th className="px-4 py-3 border-b border-l border-fdgy-cream/50 bg-fdgy-pink/5 text-fdgy-pink" colSpan={3}>Break Even</th>
                <th className="px-4 py-3 border-b border-l border-fdgy-cream/50 bg-[#6D8A65]/5 text-[#6D8A65]" colSpan={3}>Septiembre</th>
                <th className="px-4 py-3 border-b border-l border-fdgy-cream/50 bg-fdgy-navy/5 text-fdgy-navy" colSpan={3}>Diciembre</th>
              </tr>
              <tr className="text-right">
                <th className="px-4 py-2 border-b border-fdgy-cream/50"></th>
                <th className="px-4 py-2 border-b border-l border-fdgy-cream/50 bg-fdgy-pink/5">Órdenes</th>
                <th className="px-4 py-2 border-b border-fdgy-cream/50 bg-fdgy-pink/5">Sales</th>
                <th className="px-4 py-2 border-b border-fdgy-cream/50 bg-fdgy-pink/5">EBITDA</th>
                <th className="px-4 py-2 border-b border-l border-fdgy-cream/50 bg-[#6D8A65]/5">Órdenes</th>
                <th className="px-4 py-2 border-b border-fdgy-cream/50 bg-[#6D8A65]/5">Sales</th>
                <th className="px-4 py-2 border-b border-fdgy-cream/50 bg-[#6D8A65]/5">EBITDA</th>
                <th className="px-4 py-2 border-b border-l border-fdgy-cream/50 bg-fdgy-navy/5">Órdenes</th>
                <th className="px-4 py-2 border-b border-fdgy-cream/50 bg-fdgy-navy/5">Sales</th>
                <th className="px-4 py-2 border-b border-fdgy-cream/50 bg-fdgy-navy/5">EBITDA</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-fdgy-cream/30 bg-white text-right">
              {multiScenarioData.rows.map((row, i) => (
                <tr key={i} className="hover:bg-fdgy-cream/10">
                  <td className="px-4 py-3 text-left font-medium text-fdgy-navy">{row.name}</td>
                  <td className="px-4 py-3 border-l border-fdgy-cream/30 font-mono text-xs">{row.beOrders}</td>
                  <td className="px-4 py-3 font-mono text-xs">{formatCurrency(row.be.netSales)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-fdgy-pink">{formatCurrency(row.be.ebitda)} ({(row.be.ebitdaMargin * 100).toFixed(1)}%)</td>
                  <td className="px-4 py-3 border-l border-fdgy-cream/30 font-mono text-xs">{row.sepOrders}</td>
                  <td className="px-4 py-3 font-mono text-xs">{formatCurrency(row.sep.netSales)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-[#6D8A65]">{formatCurrency(row.sep.ebitda)} ({(row.sep.ebitdaMargin * 100).toFixed(1)}%)</td>
                  <td className="px-4 py-3 border-l border-fdgy-cream/30 font-mono text-xs">{row.dicOrders}</td>
                  <td className="px-4 py-3 font-mono text-xs">{formatCurrency(row.dic.netSales)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-fdgy-navy font-bold">{formatCurrency(row.dic.ebitda)} ({(row.dic.ebitdaMargin * 100).toFixed(1)}%)</td>
                </tr>
              ))}
              <tr className="bg-fdgy-cream/20 font-bold border-t-2 border-fdgy-cream">
                <td className="px-4 py-3 text-left text-fdgy-navy">TOTAL SUMATORIA</td>
                <td className="px-4 py-3 border-l border-fdgy-cream/30 font-mono text-xs">{multiScenarioData.totalBE.orders}</td>
                <td className="px-4 py-3 font-mono text-xs">{formatCurrency(multiScenarioData.totalBE.Sales)}</td>
                <td className="px-4 py-3 font-mono text-xs text-fdgy-pink">{formatCurrency(multiScenarioData.totalBE.EBITDA)} ({multiScenarioData.totalBE.Sales > 0 ? ((multiScenarioData.totalBE.EBITDA / multiScenarioData.totalBE.Sales) * 100).toFixed(1) : 0}%)</td>
                <td className="px-4 py-3 border-l border-fdgy-cream/30 font-mono text-xs">{multiScenarioData.totalSep.orders}</td>
                <td className="px-4 py-3 font-mono text-xs">{formatCurrency(multiScenarioData.totalSep.Sales)}</td>
                <td className="px-4 py-3 font-mono text-xs text-[#6D8A65]">{formatCurrency(multiScenarioData.totalSep.EBITDA)} ({multiScenarioData.totalSep.Sales > 0 ? ((multiScenarioData.totalSep.EBITDA / multiScenarioData.totalSep.Sales) * 100).toFixed(1) : 0}%)</td>
                <td className="px-4 py-3 border-l border-fdgy-cream/30 font-mono text-xs">{multiScenarioData.totalDic.orders}</td>
                <td className="px-4 py-3 font-mono text-xs">{formatCurrency(multiScenarioData.totalDic.Sales)}</td>
                <td className="px-4 py-3 font-mono text-xs text-fdgy-navy">{formatCurrency(multiScenarioData.totalDic.EBITDA)} ({multiScenarioData.totalDic.Sales > 0 ? ((multiScenarioData.totalDic.EBITDA / multiScenarioData.totalDic.Sales) * 100).toFixed(1) : 0}%)</td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>
      
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Personal Total por Apertura</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64 pt-4">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={75}
                    paddingAngle={5}
                    dataKey="totalStaff"
                    label={({ value }) => value > 0 ? `${value}` : ''}
                    labelLine={true}
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip 
                    formatter={(value: number) => [`${value} personas`, 'Total']} 
                    contentStyle={{ borderRadius: '8px', border: '1px solid #E8D2AE', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)', fontFamily: 'Nunito' }}
                  />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Gasto Total Direct Labor por Apertura</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64 pt-4">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={75}
                    paddingAngle={5}
                    dataKey="totalLaborCost"
                    label={({ payload }) => payload.laborCostPercent ? formatPercent(payload.laborCostPercent) : ''}
                    labelLine={true}
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip 
                    formatter={(value: number) => [formatCurrency(value), 'Labor Total']} 
                    contentStyle={{ borderRadius: '8px', border: '1px solid #E8D2AE', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)', fontFamily: 'Nunito' }}
                  />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Resumen por Locación</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0 sm:p-6">
          <table className="w-full text-sm text-left min-w-[600px]">
            <thead className="bg-fdgy-cream/20 text-fdgy-navy/80 text-[10px] uppercase font-bold tracking-wider">
               <tr>
                 <th className="px-4 py-3 rounded-tl-md cursor-pointer hover:bg-fdgy-cream/40" onClick={() => requestSort('name')}>
                   Nombre {sortConfig?.key === 'name' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                 </th>
                 <th className="px-4 py-3 text-right cursor-pointer hover:bg-fdgy-cream/40" onClick={() => requestSort('OrdersDay')}>
                   Órdenes / Día {sortConfig?.key === 'OrdersDay' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                 </th>
                 <th className="px-4 py-3 text-right cursor-pointer hover:bg-fdgy-cream/40" onClick={() => requestSort('GrossSales')}>
                   Gross Sales {sortConfig?.key === 'GrossSales' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                 </th>
                 <th className="px-4 py-3 text-right cursor-pointer hover:bg-fdgy-cream/40" onClick={() => requestSort('Sales')}>
                   Net Sales {sortConfig?.key === 'Sales' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                 </th>
                 <th className="px-4 py-3 text-right cursor-pointer hover:bg-fdgy-cream/40" onClick={() => requestSort('EBITDA')}>
                   EBITDA {sortConfig?.key === 'EBITDA' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                 </th>
                 <th className="px-4 py-3 text-right cursor-pointer hover:bg-fdgy-cream/40" onClick={() => requestSort('Margin')}>
                   Margin {sortConfig?.key === 'Margin' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                 </th>
                 <th className="px-4 py-3 text-right rounded-tr-md cursor-pointer hover:bg-fdgy-cream/40" onClick={() => requestSort('Payback')}>
                   Payback (meses) {sortConfig?.key === 'Payback' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                 </th>
               </tr>
            </thead>
            <tbody className="divide-y divide-fdgy-cream/50">
               {chartData.map((d, i) => (
                 <tr key={i} className="hover:bg-fdgy-cream/10 transition-colors">
                   <td className="px-4 py-3 font-bold text-fdgy-navy">{d.name}</td>
                   <td className="px-4 py-3 text-right font-medium">{d.OrdersDay}</td>
                   <td className="px-4 py-3 text-right font-mono text-fdgy-navy/70">{formatCurrency(d.GrossSales)}</td>
                   <td className="px-4 py-3 text-right font-mono font-medium text-fdgy-navy">{formatCurrency(d.Sales)}</td>
                   <td className="px-4 py-3 text-right font-mono font-bold text-fdgy-pink">{formatCurrency(d.EBITDA)}</td>
                   <td className="px-4 py-3 text-right text-fdgy-navy/80 font-bold">{formatPercent(d.Margin)}</td>
                   <td className="px-4 py-3 text-right font-mono font-bold text-fdgy-navy/80">{d.Payback !== null ? `${d.Payback.toFixed(1)} meses` : 'N/A'}</td>
                 </tr>
               ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      
      {isDetailed && (
        <Card>
          <CardHeader>
            <CardTitle>P&L Detallado (Consolidado)</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0 sm:p-6">
            <table className="w-full text-sm text-left min-w-[600px]">
              <thead className="bg-fdgy-cream/20 text-fdgy-navy/80 text-[10px] uppercase font-bold tracking-wider">
                <tr>
                  <th className="px-4 py-3 rounded-tl-md">Métrica</th>
                  <th className="px-4 py-3 text-right">Break Even (Agrupado)</th>
                  <th className="px-4 py-3 text-right">Sept 2026 (Agrupado)</th>
                  <th className="px-4 py-3 text-right rounded-tr-md">Dic 2026 (Agrupado)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-fdgy-cream/50">
                <PNLTR label="Gross Sales" valueReal={multiScenarioData.totalDic.totalSales} totalReal={multiScenarioData.totalDic.totalSales} valueBE={multiScenarioData.totalBE.totalSales} totalBE={multiScenarioData.totalBE.totalSales} valueSep={multiScenarioData.totalSep.totalSales} totalSep={multiScenarioData.totalSep.totalSales} isTotals />
                <PNLTR label="— IVA" valueReal={-multiScenarioData.totalDic.ivaDeduction} totalReal={multiScenarioData.totalDic.totalSales} valueBE={-multiScenarioData.totalBE.ivaDeduction} totalBE={multiScenarioData.totalBE.totalSales} valueSep={-multiScenarioData.totalSep.ivaDeduction} totalSep={multiScenarioData.totalSep.totalSales} isSub />
                <PNLTR label="— Cancellations" valueReal={-multiScenarioData.totalDic.cancellations} totalReal={multiScenarioData.totalDic.totalSales} valueBE={-multiScenarioData.totalBE.cancellations} totalBE={multiScenarioData.totalBE.totalSales} valueSep={-multiScenarioData.totalSep.cancellations} totalSep={multiScenarioData.totalSep.totalSales} isSub />
                <PNLTR label="Net Sales" valueReal={multiScenarioData.totalDic.netSales} totalReal={multiScenarioData.totalDic.netSales} valueBE={multiScenarioData.totalBE.netSales} totalBE={multiScenarioData.totalBE.netSales} valueSep={multiScenarioData.totalSep.netSales} totalSep={multiScenarioData.totalSep.netSales} isHeader />
                
                <PNLTR label="Cost of Goods (Food)" valueReal={-multiScenarioData.totalDic.foodCost} totalReal={multiScenarioData.totalDic.netSales} valueBE={-multiScenarioData.totalBE.foodCost} totalBE={multiScenarioData.totalBE.netSales} valueSep={-multiScenarioData.totalSep.foodCost} totalSep={multiScenarioData.totalSep.netSales} showPercent />
                <PNLTR label="Delivery Commissions" valueReal={-multiScenarioData.totalDic.commisions} totalReal={multiScenarioData.totalDic.netSales} valueBE={-multiScenarioData.totalBE.commisions} totalBE={multiScenarioData.totalBE.netSales} valueSep={-multiScenarioData.totalSep.commisions} totalSep={multiScenarioData.totalSep.netSales} showPercent />
                <PNLTR label="Contribution Margin" valueReal={multiScenarioData.totalDic.contributionMargin} totalReal={multiScenarioData.totalDic.netSales} valueBE={multiScenarioData.totalBE.contributionMargin} totalBE={multiScenarioData.totalBE.netSales} valueSep={multiScenarioData.totalSep.contributionMargin} totalSep={multiScenarioData.totalSep.netSales} isTotals showPercent />

                <PNLTR label="Fixed Costs" valueReal={-multiScenarioData.totalDic.totalFixedCosts} totalReal={multiScenarioData.totalDic.netSales} valueBE={-multiScenarioData.totalBE.totalFixedCosts} totalBE={multiScenarioData.totalBE.netSales} valueSep={-multiScenarioData.totalSep.totalFixedCosts} totalSep={multiScenarioData.totalSep.netSales} isHeader showPercent />
                <PNLTR label="— Direct Labor" valueReal={-multiScenarioData.totalDic.laborMxn} totalReal={multiScenarioData.totalDic.netSales} valueBE={-multiScenarioData.totalBE.laborMxn} totalBE={multiScenarioData.totalBE.netSales} valueSep={-multiScenarioData.totalSep.laborMxn} totalSep={multiScenarioData.totalSep.netSales} isSub showPercent />
                <PNLTR label="— Property Leases" valueReal={-(multiScenarioData.totalDic.rentMxn || 0)} totalReal={multiScenarioData.totalDic.netSales} valueBE={-(multiScenarioData.totalBE.rentMxn || 0)} totalBE={multiScenarioData.totalBE.netSales} valueSep={-(multiScenarioData.totalSep.rentMxn || 0)} totalSep={multiScenarioData.totalSep.netSales} isSub showPercent />
                <PNLTR label="— Utilities" valueReal={-multiScenarioData.totalDic.utilitiesMxn} totalReal={multiScenarioData.totalDic.netSales} valueBE={-multiScenarioData.totalBE.utilitiesMxn} totalBE={multiScenarioData.totalBE.netSales} valueSep={-multiScenarioData.totalSep.utilitiesMxn} totalSep={multiScenarioData.totalSep.netSales} isSub showPercent />
                <PNLTR label="— Inventory Transportation" valueReal={-(multiScenarioData.totalDic.inventoryTransportationMxn || 0)} totalReal={multiScenarioData.totalDic.netSales} valueBE={-(multiScenarioData.totalBE.inventoryTransportationMxn || 0)} totalBE={multiScenarioData.totalBE.netSales} valueSep={-(multiScenarioData.totalSep.inventoryTransportationMxn || 0)} totalSep={multiScenarioData.totalSep.netSales} isSub showPercent />
                <PNLTR label="— Others" valueReal={-multiScenarioData.totalDic.otherFixedMxn} totalReal={multiScenarioData.totalDic.netSales} valueBE={-multiScenarioData.totalBE.otherFixedMxn} totalBE={multiScenarioData.totalBE.netSales} valueSep={-multiScenarioData.totalSep.otherFixedMxn} totalSep={multiScenarioData.totalSep.netSales} isSub showPercent />

                <PNLTR label="Gross Margin" valueReal={multiScenarioData.totalDic.grossMargin} totalReal={multiScenarioData.totalDic.netSales} valueBE={multiScenarioData.totalBE.grossMargin} totalBE={multiScenarioData.totalBE.netSales} valueSep={multiScenarioData.totalSep.grossMargin} totalSep={multiScenarioData.totalSep.netSales} isTotals showPercent />
                <PNLTR label="Marketing" valueReal={-multiScenarioData.totalDic.marketingMxn} totalReal={multiScenarioData.totalDic.netSales} valueBE={-multiScenarioData.totalBE.marketingMxn} totalBE={multiScenarioData.totalBE.netSales} valueSep={-multiScenarioData.totalSep.marketingMxn} totalSep={multiScenarioData.totalSep.netSales} showPercent />
                <tr className="bg-fdgy-navy text-white font-bold">
                  <td className="px-4 py-3">EBITDA</td>
                  <td className="px-4 py-3 text-right">{formatCurrency(multiScenarioData.totalBE.ebitda)} ({multiScenarioData.totalBE.netSales > 0 ? ((multiScenarioData.totalBE.ebitda / multiScenarioData.totalBE.netSales) * 100).toFixed(1) : 0}%)</td>
                  <td className="px-4 py-3 text-right">{formatCurrency(multiScenarioData.totalSep.ebitda)} ({multiScenarioData.totalSep.netSales > 0 ? ((multiScenarioData.totalSep.ebitda / multiScenarioData.totalSep.netSales) * 100).toFixed(1) : 0}%)</td>
                  <td className="px-4 py-3 text-right">{formatCurrency(multiScenarioData.totalDic.ebitda)} ({multiScenarioData.totalDic.netSales > 0 ? ((multiScenarioData.totalDic.ebitda / multiScenarioData.totalDic.netSales) * 100).toFixed(1) : 0}%)</td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function PNLCalculatorView({ sim, onChange, qualitativeData }: { sim: Simulation, onChange: (updates: Partial<Simulation>) => void, qualitativeData: any[] }) {
  const { formatCurrency, country } = useCurrencyInfo();
  const curr = country === 'CO' ? 'COP' : 'MXN';
  const params = sim.params;

  const handleParamChange = (key: keyof PNLParams, value: string) => {
    onChange({ params: { ...params, [key]: parseFloat(value) || 0 } });
  };

  const isQueretaro = sim.name.toLowerCase().includes('queretaro');

  const results = calculatePNL(params, sim.name);
  const { totalSales, ivaDeduction, cancellations, netSales, foodCost, commisions, totalCogsAndComms, contributionMargin, utilitiesMxn, marketingMxn, otherFixedMxn, inventoryTransportationMxn, laborMxn, totalFixedCosts, grossMargin, totalOpex, operatingProfit, operatingProfitMargin, ebitda, ebitdaMargin } = results;

  const qualMatch = useMemo(() => {
    if (!qualitativeData) return null;
    return qualitativeData.find(d => {
      const dbName = d.nombre.toLowerCase().trim();
      const simName = sim.name.toLowerCase().trim();
      
      if (simName === 'interlomas' && dbName === 'centtral interlomas') return true;
      if (simName.includes('interlomas') && dbName.includes('centtral interlomas')) return true;
      if (simName.includes('interlomas') && !dbName.includes('centtral')) return false; // Ignore other interlomas

      return dbName === simName || 
            (dbName.includes(simName) && simName.length > 3) ||
            (simName.includes(dbName) && dbName.length > 3);
    });
  }, [sim.name, qualitativeData]);

  // Calculate Break Even Target on the fly
  const t = params.taxPercent / 100;
  const c = params.cancellationsPercent / 100;
  const f = params.cogsFoodPercent / 100;
  const deliveryCommPercent = (params.deliveryAppOrdersPercent / 100) * params.deliveryAppCommRate;
  const d = deliveryCommPercent / 100;
  const u = params.utilitiesPercent / 100;
  const effectiveMarketingPercent = ((params.deliveryAppOrdersPercent / 100) * params.marketingPercent) + (((100 - params.deliveryAppOrdersPercent) / 100) * params.directMarketingPercent);
  const m = effectiveMarketingPercent / 100;
  const o = params.otherFixedPercent / 100;
  const it = (params.inventoryTransportationPercent || 0) / 100;

  const valetCount = isQueretaro ? 0 : (params.valetCount || 0);
  const stewardCount = isQueretaro ? 0 : (params.stewardCount || 0);

  const fixedCosts = params.rentMxn + ((params.encargadoCount || 0) * (params.encargadoCost || 0) + (params.segundoCount || 0) * (params.segundoCost || 0) + (params.cocineroCount || 0) * (params.cocineroCost || 0) + (params.cajeroCount || 0) * (params.cajeroCost || 0) + valetCount * (params.valetCost || 0) + stewardCount * (params.stewardCost || 0));
  const n = (1 - t) * (1 - c);
  const marginRatio = n * (1 - f - d - u - m - o - it);
  
  let breakEvenOrdersDaily = 0;
  if (marginRatio > 0 && params.avgTicketMxn > 0 && params.daysOpen > 0) {
    const breakEvenTotalSales = fixedCosts / marginRatio;
    breakEvenOrdersDaily = Math.ceil(breakEvenTotalSales / (params.avgTicketMxn * params.daysOpen));
  }

  const beResults = calculatePNL({ ...params, ordersPerDay: breakEvenOrdersDaily }, sim.name);
  const sepResults = calculatePNL({ ...params, ordersPerDay: params.ordersPerDaySept ?? (params.ordersPerDay * 0.8) }, sim.name);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1 w-full max-w-full">
        <div className="flex items-center gap-2 group max-w-full">
          <Input 
            value={sim.name}
            onChange={(e) => onChange({ name: e.target.value })}
            className="text-xl sm:text-2xl font-bold tracking-tight text-fdgy-navy border-transparent hover:border-fdgy-navy/20 focus-visible:border-fdgy-navy focus-visible:ring-1 focus-visible:ring-fdgy-navy bg-transparent px-2 py-1 h-auto shadow-none w-full sm:max-w-[400px] transition-all"
            placeholder="Nombre de la cocina"
          />
          <Pencil className="w-4 h-4 text-fdgy-navy/50 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0" />
        </div>
        <p className="text-xs sm:text-sm text-fdgy-navy/60 px-2 mb-1">Ajusta las variables para calcular el EBITDA esperado para esta locación.</p>
        <div className="px-2 w-full max-w-2xl">
          <textarea
            value={sim.description || ''}
            onChange={(e) => onChange({ description: e.target.value })}
            className="text-xs sm:text-sm text-fdgy-navy border border-transparent hover:border-fdgy-navy/20 focus:border-fdgy-navy focus:ring-1 focus:ring-fdgy-navy bg-fdgy-cream/10 px-3 py-2 rounded-md resize-y shadow-none w-full transition-all outline-none"
            placeholder="Añadir descripción del proyecto (ej. incluye X% de ventas de otra zona)..."
            rows={2}
          />
        </div>
      </div>

      {qualMatch && (
        <Card className="bg-fdgy-cream/10 border-fdgy-cream border-solid">
          <CardHeader className="py-3 px-4 flex flex-row items-center justify-between">
            <CardTitle className="text-sm tracking-wide text-fdgy-navy/80 uppercase">Análisis Cualitativo del Local (Info Automática)</CardTitle>
            <a 
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(qualMatch.nombre + ', CDMX, Mexico')}`} 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-xs font-bold text-fdgy-pink hover:text-fdgy-pink/80 flex items-center gap-1"
            >
              <MapPin className="w-3.5 h-3.5" />
              Abrir en Maps
            </a>
          </CardHeader>
          <CardContent className="py-2 pb-4 px-4 flex flex-col sm:flex-row gap-6">
            <div className="flex-1">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-fdgy-navy/90">
                {qualMatch['TRÁFICO'] && <div className="flex flex-col"><span className="text-[10px] text-fdgy-navy/50 uppercase font-bold">Entorno</span><span>{qualMatch['TRÁFICO']}</span></div>}
                {qualMatch['M2'] && <div className="flex flex-col"><span className="text-[10px] text-fdgy-navy/50 uppercase font-bold">M2</span><span>{qualMatch['M2']} m²</span></div>}
                {qualMatch['RENTA TOTAL'] && <div className="flex flex-col"><span className="text-[10px] text-fdgy-navy/50 uppercase font-bold">Renta Cotizada</span><span className="font-mono">{qualMatch['RENTA TOTAL']}</span></div>}
                {qualMatch['CALIFICACIÓN'] && <div className="flex flex-col"><span className="text-[10px] text-fdgy-navy/50 uppercase font-bold">Calificación</span><span className="font-bold text-fdgy-green">{qualMatch['CALIFICACIÓN']} / 5</span></div>}
                {qualMatch['APLICA A VISITA'] && <div className="flex flex-col"><span className="text-[10px] text-fdgy-navy/50 uppercase font-bold">Aprobado</span><span className="font-bold">{qualMatch['APLICA A VISITA']}</span></div>}
              </div>
              {qualMatch['QUE LOCALES/ NEGOCIOS HAY CERCA'] && (
                <div className="mt-3 pt-3 border-t border-fdgy-cream/50 text-xs text-fdgy-navy/80">
                  <span className="font-bold uppercase tracking-widest text-[10px] text-fdgy-navy/50 block mb-1">Locales Cercanos:</span> {qualMatch['QUE LOCALES/ NEGOCIOS HAY CERCA']}
                </div>
              )}
            </div>
            <div className="w-full sm:w-[200px] shrink-0 h-[100px] rounded-lg overflow-hidden border border-fdgy-cream/50">
               <iframe
                  width="100%"
                  height="100%"
                  frameBorder="0"
                  style={{ border: 0 }}
                  src={`https://maps.google.com/maps?q=${encodeURIComponent(qualMatch.nombre + ', CDMX, Mexico')}&t=&z=15&ie=UTF8&iwloc=&output=embed`}
                  allowFullScreen
                />
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <aside className="xl:col-span-4 flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Variables de Ingreso</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <InputGroup label="Órdenes Diarias Estimadas (Diciembre)" value={params.ordersPerDay} onChange={(v) => handleParamChange('ordersPerDay', v)} />
                </div>
                <div className="flex-1">
                  <InputGroup label={sim.name.toLowerCase().includes('queretaro') ? "Órdenes Diarias Estimadas (Mercado potencial)" : "Órdenes Diarias Estimadas (Septiembre)"} value={params.ordersPerDaySept ?? (params.ordersPerDay * 0.8)} onChange={(v) => handleParamChange('ordersPerDaySept', v)} />
                </div>
              </div>
              <InputGroup label={`Ticket Promedio (${curr})`} value={params.avgTicketMxn} onChange={(v) => handleParamChange('avgTicketMxn', v)} icon={<DollarSign className="w-4 h-4 text-fdgy-navy/50" />} />
              <InputGroup label="Días Operativos / Mes" value={params.daysOpen} onChange={(v) => handleParamChange('daysOpen', v)} />
              <InputGroup label="IVA (%)" value={params.taxPercent} onChange={(v) => handleParamChange('taxPercent', v)} icon={<Percent className="w-4 h-4 text-fdgy-navy/50" />} />
              <InputGroup label="Cancelaciones y Devoluciones (%)" value={params.cancellationsPercent} onChange={(v) => handleParamChange('cancellationsPercent', v)} icon={<Percent className="w-4 h-4 text-fdgy-navy/50" />} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Costos Variables (COGS)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <InputGroup label="Costo de Alimentos (%)" value={params.cogsFoodPercent} onChange={(v) => handleParamChange('cogsFoodPercent', v)} icon={<Percent className="w-4 h-4 text-fdgy-navy/50" />} />
              <InputGroup label="% Órdenes por Delivery App" value={params.deliveryAppOrdersPercent} onChange={(v) => handleParamChange('deliveryAppOrdersPercent', v)} icon={<Percent className="w-4 h-4 text-fdgy-navy/50" />} />
              <InputGroup label="Comisión Delivery App (%)" value={params.deliveryAppCommRate} onChange={(v) => handleParamChange('deliveryAppCommRate', v)} icon={<Percent className="w-4 h-4 text-fdgy-navy/50" />} />
              
              <div className="bg-fdgy-cream/20 p-3 rounded-xl border border-fdgy-cream/50 flex flex-col mt-2">
                <p className="text-xs text-fdgy-navy/70 font-bold uppercase tracking-wider mb-1">Comisión Ponderada Total</p>
                <p className="text-2xl font-extrabold text-fdgy-navy">{formatPercent((params.deliveryAppOrdersPercent / 100) * (params.deliveryAppCommRate / 100))}</p>
                <p className="text-[10px] text-fdgy-navy/60 font-bold leading-relaxed mt-2 uppercase tracking-wide">
                  ({params.deliveryAppOrdersPercent}% Orders x {params.deliveryAppCommRate}% Comm)
                  <br/>
                  + ({100 - params.deliveryAppOrdersPercent}% Direct x 0% Comm)
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Costos Fijos (OPEX)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <InputGroup label={`Renta Mensual (${curr})`} value={params.rentMxn} onChange={(v) => handleParamChange('rentMxn', v)} icon={<DollarSign className="w-4 h-4 text-fdgy-navy/50" />} />
              
              <div className="bg-fdgy-cream/20 p-4 rounded-xl border border-fdgy-cream/50 space-y-3">
                <div className="flex justify-between items-center bg-white p-2 rounded-lg border border-fdgy-cream/50 mb-3 text-[10px] uppercase tracking-wider font-bold text-fdgy-navy/80">
                  <span className="w-1/3">Rol</span>
                  <span className="w-1/4 text-center"># Personas</span>
                  <span className="w-1/4 text-center">Costo c/u</span>
                  <span className="w-1/6 text-right">Total</span>
                </div>
                
                <div className="flex justify-between items-center gap-2">
                  <span className="w-1/3 text-xs font-bold text-fdgy-navy">Encargado</span>
                  <div className="w-1/4"><Input type="number" value={params.encargadoCount ?? ''} onChange={(e) => handleParamChange('encargadoCount', e.target.value)} className="h-8 text-xs text-center px-1" /></div>
                  <div className="w-1/4"><Input type="number" value={params.encargadoCost ?? ''} onChange={(e) => handleParamChange('encargadoCost', e.target.value)} className="h-8 text-xs text-center px-1" /></div>
                  <span className="w-1/6 text-right text-xs font-mono font-bold">{formatCurrency((params.encargadoCount || 0) * (params.encargadoCost || 0))}</span>
                </div>

                <div className="flex justify-between items-center gap-2">
                  <span className="w-1/3 text-xs font-bold text-fdgy-navy">Segundo</span>
                  <div className="w-1/4"><Input type="number" value={params.segundoCount ?? ''} onChange={(e) => handleParamChange('segundoCount', e.target.value)} className="h-8 text-xs text-center px-1" /></div>
                  <div className="w-1/4"><Input type="number" value={params.segundoCost ?? ''} onChange={(e) => handleParamChange('segundoCost', e.target.value)} className="h-8 text-xs text-center px-1" /></div>
                  <span className="w-1/6 text-right text-xs font-mono font-bold">{formatCurrency((params.segundoCount || 0) * (params.segundoCost || 0))}</span>
                </div>

                <div className="flex justify-between items-center gap-2">
                  <span className="w-1/3 text-xs font-bold text-fdgy-navy">Cocinero</span>
                  <div className="w-1/4"><Input type="number" value={params.cocineroCount ?? ''} onChange={(e) => handleParamChange('cocineroCount', e.target.value)} className="h-8 text-xs text-center px-1" /></div>
                  <div className="w-1/4"><Input type="number" value={params.cocineroCost ?? ''} onChange={(e) => handleParamChange('cocineroCost', e.target.value)} className="h-8 text-xs text-center px-1" /></div>
                  <span className="w-1/6 text-right text-xs font-mono font-bold">{formatCurrency((params.cocineroCount || 0) * (params.cocineroCost || 0))}</span>
                </div>

                <div className="flex justify-between items-center gap-2">
                  <span className="w-1/3 text-xs font-bold text-fdgy-navy">Cajero/Pase</span>
                  <div className="w-1/4"><Input type="number" value={params.cajeroCount ?? ''} onChange={(e) => handleParamChange('cajeroCount', e.target.value)} className="h-8 text-xs text-center px-1" /></div>
                  <div className="w-1/4"><Input type="number" value={params.cajeroCost ?? ''} onChange={(e) => handleParamChange('cajeroCost', e.target.value)} className="h-8 text-xs text-center px-1" /></div>
                  <span className="w-1/6 text-right text-xs font-mono font-bold">{formatCurrency((params.cajeroCount || 0) * (params.cajeroCost || 0))}</span>
                </div>

                {!sim.name.toLowerCase().includes('queretaro') && (
                  <>
                    <div className="flex justify-between items-center gap-2">
                      <span className="w-1/3 text-xs font-bold text-fdgy-navy">Valet Parking</span>
                      <div className="w-1/4"><Input type="number" value={params.valetCount ?? ''} onChange={(e) => handleParamChange('valetCount', e.target.value)} className="h-8 text-xs text-center px-1" /></div>
                      <div className="w-1/4"><Input type="number" value={params.valetCost ?? ''} onChange={(e) => handleParamChange('valetCost', e.target.value)} className="h-8 text-xs text-center px-1" /></div>
                      <span className="w-1/6 text-right text-xs font-mono font-bold">{formatCurrency((params.valetCount || 0) * (params.valetCost || 0))}</span>
                    </div>
                    <div className="flex justify-between items-center gap-2">
                      <span className="w-1/3 text-xs font-bold text-fdgy-navy">Steward</span>
                      <div className="w-1/4"><Input type="number" value={params.stewardCount ?? ''} onChange={(e) => handleParamChange('stewardCount', e.target.value)} className="h-8 text-xs text-center px-1" /></div>
                      <div className="w-1/4"><Input type="number" value={params.stewardCost ?? ''} onChange={(e) => handleParamChange('stewardCost', e.target.value)} className="h-8 text-xs text-center px-1" /></div>
                      <span className="w-1/6 text-right text-xs font-mono font-bold">{formatCurrency((params.stewardCount || 0) * (params.stewardCost || 0))}</span>
                    </div>
                  </>
                )}

                <div className="flex justify-between items-center pt-2 border-t border-fdgy-navy/10 mt-2">
                  <span className="font-bold text-xs uppercase text-fdgy-navy">Total Labor / Nómina:</span>
                  <span className="font-bold font-mono text-fdgy-navy">{formatCurrency((params.encargadoCount || 0) * (params.encargadoCost || 0) + (params.segundoCount || 0) * (params.segundoCost || 0) + (params.cocineroCount || 0) * (params.cocineroCost || 0) + (params.cajeroCount || 0) * (params.cajeroCost || 0) + (!sim.name.toLowerCase().includes('queretaro') ? ((params.valetCount || 0) * (params.valetCost || 0) + (params.stewardCount || 0) * (params.stewardCost || 0)) : 0))}</span>
                </div>
              </div>

              <InputGroup label="Servicios / Utilities (%)" value={params.utilitiesPercent} onChange={(v) => handleParamChange('utilitiesPercent', v)} icon={<Percent className="w-4 h-4 text-fdgy-navy/50" />} />
              <InputGroup label="Marketing Delivery (%)" value={params.marketingPercent} onChange={(v) => handleParamChange('marketingPercent', v)} icon={<Percent className="w-4 h-4 text-fdgy-navy/50" />} />
              <InputGroup label="Marketing Venta Directa (%)" value={params.directMarketingPercent} onChange={(v) => handleParamChange('directMarketingPercent', v)} icon={<Percent className="w-4 h-4 text-fdgy-navy/50" />} />
              
              <div className="bg-fdgy-cream/20 p-3 rounded-xl border border-fdgy-cream/50 flex flex-col mt-2">
                <p className="text-xs text-fdgy-navy/70 font-bold uppercase tracking-wider mb-1">Marketing Total Promedio</p>
                <p className="text-2xl font-extrabold text-fdgy-navy">{formatPercent((((params.deliveryAppOrdersPercent / 100) * params.marketingPercent) + (((100 - params.deliveryAppOrdersPercent) / 100) * params.directMarketingPercent)) / 100)}</p>
                <p className="text-[10px] text-fdgy-navy/60 font-bold leading-relaxed mt-2 uppercase tracking-wide">
                  ({params.deliveryAppOrdersPercent}% Orders x {params.marketingPercent}% Mkt)
                  <br/>
                  + ({100 - params.deliveryAppOrdersPercent}% Direct x {params.directMarketingPercent}% Mkt)
                </p>
              </div>

              {sim.name.toLowerCase().includes('queretaro') && (
                <InputGroup label="Inventory Transp. (%)" value={params.inventoryTransportationPercent || 0} onChange={(v) => handleParamChange('inventoryTransportationPercent', v)} icon={<Percent className="w-4 h-4 text-fdgy-navy/50" />} />
              )}
              <InputGroup label="Otros Gastos (%)" value={params.otherFixedPercent} onChange={(v) => handleParamChange('otherFixedPercent', v)} icon={<Percent className="w-4 h-4 text-fdgy-navy/50" />} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Inversión</CardTitle>
            </CardHeader>
            <CardContent>
              <InputGroup label={`Inversión Total del Proyecto (${curr})`} value={params.totalInvestmentMxn} onChange={(v) => handleParamChange('totalInvestmentMxn', v)} icon={<DollarSign className="w-4 h-4 text-fdgy-navy/50" />} />
            </CardContent>
          </Card>
        </aside>

        <section className="xl:col-span-8 flex flex-col gap-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-white p-5 rounded-2xl border border-fdgy-cream shadow-sm relative overflow-hidden">
              <div className="absolute top-0 left-0 w-1 h-full bg-fdgy-pink"></div>
              <p className="text-xs font-bold text-fdgy-navy/60 mb-2 uppercase tracking-wider flex items-center gap-1.5"><Target className="w-3.5 h-3.5" /> Escenario Break Even</p>
              <div className="flex justify-between items-end mb-4">
                <div>
                  <p className="text-[10px] text-fdgy-navy/50 font-bold uppercase tracking-wider">Revenue</p>
                  <h4 className="text-2xl font-bold text-fdgy-navy">{formatCurrency(beResults.netSales)}</h4>
                </div>
                <div className="text-right">
                  <p className="text-[10px] text-fdgy-navy/50 font-bold uppercase tracking-wider">EBITDA</p>
                  <h4 className="text-xl font-bold text-fdgy-pink">{formatCurrency(beResults.ebitda)}</h4>
                </div>
              </div>
              <div className="flex justify-between items-center pt-3 border-t border-fdgy-cream/50">
                <p className="text-xs font-bold text-fdgy-navy/70">Margin: 0%</p>
                <p className="text-xs font-bold text-fdgy-pink">{breakEvenOrdersDaily} órdenes/día</p>
              </div>
            </div>

            <div className="bg-white p-5 rounded-2xl border border-fdgy-cream shadow-sm relative overflow-hidden">
              <div className="absolute top-0 left-0 w-1 h-full bg-[#6D8A65]"></div>
              <p className="text-xs font-bold text-fdgy-navy/60 mb-2 uppercase tracking-wider flex items-center gap-1.5"><Target className="w-3.5 h-3.5" /> Escenario {sim.name.toLowerCase().includes('queretaro') ? 'Mercado potencial' : 'Septiembre'}</p>
              <div className="flex justify-between items-end mb-4">
                <div>
                  <p className="text-[10px] text-fdgy-navy/50 font-bold uppercase tracking-wider">Revenue</p>
                  <h4 className="text-2xl font-bold text-fdgy-navy">{formatCurrency(sepResults.netSales)}</h4>
                </div>
                <div className="text-right">
                  <p className="text-[10px] text-fdgy-navy/50 font-bold uppercase tracking-wider">EBITDA</p>
                  <h4 className="text-xl font-bold text-[#6D8A65]">{formatCurrency(sepResults.ebitda)}</h4>
                </div>
              </div>
              <div className="flex justify-between items-center pt-3 border-t border-fdgy-cream/50">
                <p className="text-xs font-bold text-fdgy-navy/70">Margin: {formatPercent(sepResults.ebitdaMargin)}</p>
                <p className="text-xs font-bold text-[#6D8A65]">{params.ordersPerDaySept ?? (params.ordersPerDay * 0.8)} órdenes/día</p>
              </div>
            </div>

            <div className="bg-white p-5 rounded-2xl border border-fdgy-cream shadow-sm relative overflow-hidden">
              <div className="absolute top-0 left-0 w-1 h-full bg-fdgy-navy"></div>
              <p className="text-xs font-bold text-fdgy-navy/60 mb-2 uppercase tracking-wider">Escenario Diciembre</p>
              <div className="flex justify-between items-end mb-4">
                <div>
                  <p className="text-[10px] text-fdgy-navy/50 font-bold uppercase tracking-wider">Revenue</p>
                  <h4 className="text-2xl font-bold text-fdgy-navy">{formatCurrency(netSales)}</h4>
                </div>
                <div className="text-right">
                  <p className="text-[10px] text-fdgy-navy/50 font-bold uppercase tracking-wider">EBITDA</p>
                  <h4 className="text-xl font-bold text-fdgy-navy">{formatCurrency(ebitda)}</h4>
                </div>
              </div>
              <div className="flex justify-between items-center pt-3 border-t border-fdgy-cream/50">
                <p className="text-xs font-bold text-fdgy-navy/70">Margin: {formatPercent(ebitdaMargin)}</p>
                <p className="text-xs font-bold text-fdgy-navy/70">{params.ordersPerDay} órdenes/día</p>
              </div>
            </div>
          </div>

          <Card className="flex-1">
            <CardHeader className="flex flex-row justify-between items-center bg-fdgy-cream/20">
              <div>
                <CardTitle>P&L Waterfall Structure</CardTitle>
                <div className="text-[10px] text-fdgy-navy/60 font-bold mt-1 uppercase">ALL VALUES IN MXN</div>
              </div>
            </CardHeader>
            <CardContent className="p-0 sm:p-6 overflow-x-auto">
              <table className="w-full text-sm mt-2 min-w-[700px] text-left">
                <thead className="text-fdgy-navy/50 text-[10px] uppercase tracking-widest font-bold border-b border-fdgy-cream/50">
                  <tr className="text-left">
                    <th className="pb-3 w-[25%]">Item Detail</th>
                    <th className="pb-3 text-right border-l border-fdgy-cream/30 px-2 text-fdgy-pink pr-4 w-[25%]">Break Even</th>
                    <th className="pb-3 text-right border-l border-fdgy-cream/30 px-2 text-[#6D8A65] pr-4 w-[25%]">{sim.name.toLowerCase().includes('queretaro') ? 'Mercado potencial' : 'Septiembre'}</th>
                    <th className="pb-3 text-right border-l border-fdgy-cream/30 pl-2 pr-4 w-[25%] text-fdgy-navy">Diciembre</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-fdgy-cream/30">
                  <PNLTR label="Total Sales (GMV)" valueReal={totalSales} totalReal={netSales} valueBE={beResults.totalSales} totalBE={beResults.netSales} valueSep={sepResults.totalSales} totalSep={sepResults.netSales} isHeader />
                  <PNLTR label="— Impuesto (IVA)" valueReal={-ivaDeduction} totalReal={netSales} valueBE={-beResults.ivaDeduction} totalBE={beResults.netSales} valueSep={-sepResults.ivaDeduction} totalSep={sepResults.netSales} isSub />
                  <PNLTR label="— Cancelaciones & Dev." valueReal={-cancellations} totalReal={netSales} valueBE={-beResults.cancellations} totalBE={beResults.netSales} valueSep={-sepResults.cancellations} totalSep={sepResults.netSales} isSub />
                  <PNLTR label="Net Revenues" valueReal={netSales} totalReal={netSales} valueBE={beResults.netSales} totalBE={beResults.netSales} valueSep={sepResults.netSales} totalSep={sepResults.netSales} isTotals />

                  <PNLTR label="Variable Costs" valueReal={-totalCogsAndComms} totalReal={netSales} valueBE={-beResults.totalCogsAndComms} totalBE={beResults.netSales} valueSep={-sepResults.totalCogsAndComms} totalSep={sepResults.netSales} isHeader showPercent />
                  <PNLTR label="— Agregators Fee" valueReal={-commisions} totalReal={netSales} valueBE={-beResults.commisions} totalBE={beResults.netSales} valueSep={-sepResults.commisions} totalSep={sepResults.netSales} isSub showPercent />
                  <PNLTR label="— Total COGS" valueReal={-foodCost} totalReal={netSales} valueBE={-beResults.foodCost} totalBE={beResults.netSales} valueSep={-sepResults.foodCost} totalSep={sepResults.netSales} isSub showPercent />
                  
                  <PNLTR label="Contribution Margin" valueReal={contributionMargin} totalReal={netSales} valueBE={beResults.contributionMargin} totalBE={beResults.netSales} valueSep={sepResults.contributionMargin} totalSep={sepResults.netSales} isTotals showPercent />

                  <PNLTR label="Fixed Costs" valueReal={-totalFixedCosts} totalReal={netSales} valueBE={-beResults.totalFixedCosts} totalBE={beResults.netSales} valueSep={-sepResults.totalFixedCosts} totalSep={sepResults.netSales} isHeader showPercent />
                  <PNLTR label="— Direct Labor" valueReal={-laborMxn} totalReal={netSales} valueBE={-beResults.laborMxn} totalBE={beResults.netSales} valueSep={-sepResults.laborMxn} totalSep={sepResults.netSales} isSub showPercent />
                  <PNLTR label="— Property Leases" valueReal={-params.rentMxn} totalReal={netSales} valueBE={-params.rentMxn} totalBE={beResults.netSales} valueSep={-params.rentMxn} totalSep={sepResults.netSales} isSub showPercent />
                  <PNLTR label="— Utilities" valueReal={-utilitiesMxn} totalReal={netSales} valueBE={-beResults.utilitiesMxn} totalBE={beResults.netSales} valueSep={-sepResults.utilitiesMxn} totalSep={sepResults.netSales} isSub showPercent />
                  {sim.name.toLowerCase().includes('queretaro') && (
                    <PNLTR label="— Inventory Transportation" valueReal={-inventoryTransportationMxn} totalReal={netSales} valueBE={-beResults.inventoryTransportationMxn} totalBE={beResults.netSales} valueSep={-sepResults.inventoryTransportationMxn} totalSep={sepResults.netSales} isSub showPercent />
                  )}
                  <PNLTR label="— Others" valueReal={-otherFixedMxn} totalReal={netSales} valueBE={-beResults.otherFixedMxn} totalBE={beResults.netSales} valueSep={-sepResults.otherFixedMxn} totalSep={sepResults.netSales} isSub showPercent />

                  <PNLTR label="Gross Margin" valueReal={grossMargin} totalReal={netSales} valueBE={beResults.grossMargin} totalBE={beResults.netSales} valueSep={sepResults.grossMargin} totalSep={sepResults.netSales} isTotals showPercent />

                  <PNLTR label="Marketing" valueReal={-marketingMxn} totalReal={netSales} valueBE={-beResults.marketingMxn} totalBE={beResults.netSales} valueSep={-sepResults.marketingMxn} totalSep={sepResults.netSales} showPercent />

                  <tr className="bg-fdgy-navy text-white font-bold">
                    <td className="py-4 pl-4 rounded-tl-xl sm:rounded-bl-xl">Operating Profit</td>
                    <td className="py-4 pr-4 text-right font-mono border-l border-white/20 px-2 text-fdgy-pink">
                       <div className="flex justify-end gap-2 items-center">
                         <span>{formatCurrency(beResults.operatingProfit)}</span>
                         <span className="text-[10px] text-fdgy-pink/60 w-10 text-right">{formatPercent(beResults.operatingProfitMargin)}</span>
                       </div>
                    </td>
                    <td className="py-4 pr-4 text-right font-mono border-l border-white/20 px-2 text-[#6D8A65]">
                       <div className="flex justify-end gap-2 items-center">
                         <span>{formatCurrency(sepResults.operatingProfit)}</span>
                         <span className="text-[10px] text-[#6D8A65]/80 w-10 text-right">{formatPercent(sepResults.operatingProfitMargin)}</span>
                       </div>
                    </td>
                    <td className="py-4 pr-4 text-right font-mono border-l border-white/20 pl-2">
                       <div className="flex justify-end gap-2 items-center">
                         <span>{formatCurrency(operatingProfit)}</span>
                         <span className="text-[10px] text-white/50 w-10 text-right">{formatPercent(operatingProfitMargin)}</span>
                       </div>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div className="mt-6 p-4 rounded-xl bg-fdgy-cream/20 border border-fdgy-cream flex items-start gap-3">
                <div className="w-5 h-5 rounded-full bg-fdgy-navy flex items-center justify-center text-white text-xs font-bold italic shrink-0">i</div>
                <p className="text-xs text-fdgy-navy font-medium leading-relaxed">This model assumes a blended {(params.deliveryAppOrdersPercent / 100) * params.deliveryAppCommRate}% aggregator commission charged on GMV. Minimizing delivery fees and waste leads to a higher Store EBITDA Margin.</p>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-fdgy-navy text-white">
            <CardHeader>
              <CardTitle className="text-white">Retorno de Inversión (Escenario Diciembre)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                  <p className="text-sm font-bold text-white/60 uppercase tracking-wider mb-1">Inversión Total</p>
                  <p className="text-2xl font-extrabold">{formatCurrency(params.totalInvestmentMxn)}</p>
                </div>
                <div className="sm:text-right">
                  <p className="text-sm font-bold text-white/60 uppercase tracking-wider mb-1">Payback</p>
                  <p className="text-3xl font-extrabold text-fdgy-pink">
                    {ebitda > 0 ? `${(params.totalInvestmentMxn / ebitda).toFixed(1)} meses` : "N/A (EBITDA Negativo o Cero)"}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}

function formatPercent(value: number) {
  return new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 1 }).format(value);
}

function InputGroup({ label, value, onChange, icon }: { label: string, value: number, onChange: (v: string) => void, icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-bold text-fdgy-navy uppercase tracking-wider">{label}</label>
      <div className="relative">
        {icon && (
           <div className="absolute left-3 top-1/2 -translate-y-1/2">
             {icon}
           </div>
        )}
        <Input 
          type="number" 
          value={value ?? ''} 
          onChange={(e) => onChange(e.target.value)} 
          className={cn(icon && "pl-9")}
        />
      </div>
    </div>
  )
}

function PNLTR({ label, valueReal, totalReal, valueBE, totalBE, valueSep, totalSep, isHeader, isSub, isTotals, showPercent }: { label: string, valueReal: number, totalReal: number, valueBE: number, totalBE: number, valueSep?: number, totalSep?: number, isHeader?: boolean, isSub?: boolean, isTotals?: boolean, showPercent?: boolean }) {
  const { formatCurrency } = useCurrencyInfo();
  return (
    <tr className={cn(
      "hover:bg-fdgy-cream/20 transition-colors",
      isHeader && "font-bold text-fdgy-navy",
      isSub && "text-fdgy-navy/60 text-sm",
      isTotals && "bg-fdgy-cream/30 font-extrabold text-fdgy-navy"
    )}>
      <td className={cn("py-3", isSub && "pl-4", (isTotals || isHeader) && "font-bold", isTotals && "font-extrabold")}>
        {label}
      </td>
      
      <td className={cn("py-3 px-2 pr-4 text-right font-mono border-l border-fdgy-cream/30", valueBE < 0 ? "text-fdgy-pink/80" : "text-fdgy-pink", (!isSub && !isHeader && !isTotals) && "font-mono")}>
        <div className="flex justify-end gap-2 items-center">
          <span>{valueBE < 0 ? `(${formatCurrency(Math.abs(valueBE))})` : formatCurrency(valueBE)}</span>
          {showPercent && <span className="text-[10px] opacity-70 w-10 text-right font-bold">{totalBE > 0 ? formatPercent(Math.abs(valueBE) / totalBE) : '0%'}</span>}
        </div>
      </td>
      
      {/* Septiembre */}
      {valueSep !== undefined && totalSep !== undefined && (
        <td className={cn("py-3 px-2 pr-4 text-right font-mono border-l border-fdgy-cream/30", valueSep < 0 ? "text-[#6D8A65]/80" : "text-[#6D8A65]", (!isSub && !isHeader && !isTotals) && "font-mono")}>
          <div className="flex justify-end gap-2 items-center">
            <span>{valueSep < 0 ? `(${formatCurrency(Math.abs(valueSep))})` : formatCurrency(valueSep)}</span>
            {showPercent && <span className="text-[10px] opacity-70 w-10 text-right font-bold">{totalSep > 0 ? formatPercent(Math.abs(valueSep) / totalSep) : '0%'}</span>}
          </div>
        </td>
      )}

      {/* Diciembre (Objetivo) */}
      <td className={cn("py-3 pr-4 text-right font-mono border-l border-fdgy-cream/30 pl-2 text-fdgy-navy", valueReal < 0 && "text-fdgy-navy/60", (!isSub && !isHeader && !isTotals) && "font-mono")}>
        <div className="flex justify-end gap-2 items-center">
          <span>{valueReal < 0 ? `(${formatCurrency(Math.abs(valueReal))})` : formatCurrency(valueReal)}</span>
          {showPercent && <span className="text-[10px] text-fdgy-navy/40 w-10 text-right font-bold">{totalReal > 0 ? formatPercent(Math.abs(valueReal) / totalReal) : '0%'}</span>}
        </div>
      </td>
    </tr>
  );
}

