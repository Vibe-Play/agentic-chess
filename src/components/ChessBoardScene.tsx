import { Suspense, useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { ContactShadows, Environment, OrbitControls, OrthographicCamera, PerspectiveCamera, useGLTF } from '@react-three/drei'
import { type Chess, type Color, type PieceSymbol, type Square } from 'chess.js'
import * as THREE from 'three'

type BoardPiece = {
  key: string
  square: Square
  color: Color
  type: PieceSymbol
}

type LastMove = {
  from: Square
  to: Square
} | null

type ChessBoardSceneProps = {
  game: Chess
  orientation: 'white' | 'black'
  viewMode: '3d' | '2d'
  selectedSquare: Square | null
  legalTargets: Square[]
  lastMove: LastMove
  onSquareSelect: (square: Square) => void
}

const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const
const ranks = ['1', '2', '3', '4', '5', '6', '7', '8'] as const
const pieceNames: Record<PieceSymbol, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
}

function toSquare(fileIndex: number, rankIndex: number): Square {
  return `${files[fileIndex]}${ranks[rankIndex]}` as Square
}

function squarePosition(square: Square, orientation: 'white' | 'black'): [number, number, number] {
  const file = files.indexOf(square[0] as (typeof files)[number])
  const rank = ranks.indexOf(square[1] as (typeof ranks)[number])
  const orientedFile = orientation === 'white' ? file : 7 - file
  const orientedRank = orientation === 'white' ? rank : 7 - rank

  return [orientedFile - 3.5, 0, orientedRank - 3.5]
}

function useBoardPieces(game: Chess) {
  return useMemo(() => {
    const pieces: BoardPiece[] = []
    game.board().forEach((row) => {
      row.forEach((piece) => {
        if (!piece) return
        pieces.push({
          key: `${piece.color}-${piece.type}-${piece.square}`,
          square: piece.square,
          color: piece.color,
          type: piece.type,
        })
      })
    })
    return pieces
  }, [game])
}

export function ChessBoardScene(props: ChessBoardSceneProps) {
  const pieces = useBoardPieces(props.game)

  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
    >
      <color attach="background" args={['#020305']} />
      <fog attach="fog" args={['#020305', 17, 32]} />
      <SceneCamera viewMode={props.viewMode} />
      <SceneLighting />
      <group position={[0, -0.2, 0]}>
        <Board
          orientation={props.orientation}
          selectedSquare={props.selectedSquare}
          legalTargets={props.legalTargets}
          lastMove={props.lastMove}
          onSquareSelect={props.onSquareSelect}
        />
        <Suspense fallback={null}>
          {pieces.map((piece) => (
            <ChessPiece
              key={piece.key}
              piece={piece}
              orientation={props.orientation}
              isSelected={props.selectedSquare === piece.square}
            />
          ))}
        </Suspense>
      </group>
      <ContactShadows position={[0, -0.29, 0]} opacity={0.58} blur={2.8} far={9} />
      <Environment preset="city" environmentIntensity={0.18} />
      {props.viewMode === '3d' && (
        <OrbitControls
          makeDefault
          enableDamping
          enablePan
          enableRotate
          enableZoom
          dampingFactor={0.08}
          panSpeed={0.85}
          rotateSpeed={0.85}
          zoomSpeed={0.9}
          screenSpacePanning
          minDistance={5}
          maxDistance={24}
          maxPolarAngle={Math.PI / 2.05}
          minPolarAngle={Math.PI / 8}
        />
      )}
    </Canvas>
  )
}

function SceneCamera({ viewMode }: { viewMode: '3d' | '2d' }) {
  const { size } = useThree()
  const orthographicZoom = Math.max(36, Math.min(size.width, size.height) / 10.8)

  if (viewMode === '2d') {
    return (
      <OrthographicCamera
        makeDefault
        position={[0, 12, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        zoom={orthographicZoom}
        near={0.1}
        far={80}
      />
    )
  }

  return (
    <PerspectiveCamera
      makeDefault
      position={[5.8, 7.2, 8.2]}
      fov={42}
      near={0.1}
      far={90}
      onUpdate={(camera) => camera.lookAt(0, 0, 0)}
    />
  )
}

function SceneLighting() {
  return (
    <>
      <hemisphereLight args={['#d9e7ff', '#050505', 0.85]} />
      <directionalLight
        castShadow
        position={[-4, 8, 5]}
        intensity={3.15}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-7}
        shadow-camera-right={7}
        shadow-camera-top={7}
        shadow-camera-bottom={-7}
      />
      <pointLight position={[4, 3, -5]} color="#7fb7ff" intensity={18} distance={18} />
    </>
  )
}

function Board({
  orientation,
  selectedSquare,
  legalTargets,
  lastMove,
  onSquareSelect,
}: Pick<ChessBoardSceneProps, 'orientation' | 'selectedSquare' | 'legalTargets' | 'lastMove' | 'onSquareSelect'>) {
  const legalSet = useMemo(() => new Set(legalTargets), [legalTargets])

  const squares = useMemo(() => {
    const result: { square: Square; position: [number, number, number]; isLight: boolean }[] = []
    for (let rank = 0; rank < 8; rank += 1) {
      for (let file = 0; file < 8; file += 1) {
        const square = toSquare(file, rank)
        result.push({
          square,
          position: squarePosition(square, orientation),
          isLight: (file + rank) % 2 === 1,
        })
      }
    }
    return result
  }, [orientation])

  return (
    <group>
      <mesh receiveShadow position={[0, -0.2, 0]}>
        <boxGeometry args={[9.2, 0.36, 9.2]} />
        <meshStandardMaterial color="#050506" roughness={0.55} metalness={0.12} />
      </mesh>
      <mesh receiveShadow position={[0, -0.04, 0]}>
        <boxGeometry args={[8.52, 0.12, 8.52]} />
        <meshStandardMaterial color="#0d0a08" roughness={0.42} metalness={0.16} />
      </mesh>
      {squares.map((square) => {
        const isSelected = selectedSquare === square.square
        const isLegal = legalSet.has(square.square)
        const isLastMove = lastMove?.from === square.square || lastMove?.to === square.square
        return (
          <BoardSquare
            key={square.square}
            square={square.square}
            position={square.position}
            isLight={square.isLight}
            isSelected={isSelected}
            isLegal={isLegal}
            isLastMove={isLastMove}
            onSquareSelect={onSquareSelect}
          />
        )
      })}
    </group>
  )
}

function BoardSquare({
  square,
  position,
  isLight,
  isSelected,
  isLegal,
  isLastMove,
  onSquareSelect,
}: {
  square: Square
  position: [number, number, number]
  isLight: boolean
  isSelected: boolean
  isLegal: boolean
  isLastMove: boolean
  onSquareSelect: (square: Square) => void
}) {
  const color = isSelected ? '#f0c94f' : isLastMove ? '#557f72' : isLight ? '#c7ab82' : '#2d211b'
  const emissive = isLegal ? '#3fb27f' : '#000000'

  return (
    <group position={[position[0], 0.08, position[2]]}>
      <mesh
        receiveShadow
        onClick={(event) => {
          event.stopPropagation()
          onSquareSelect(square)
        }}
        onPointerOver={(event) => {
          event.stopPropagation()
          document.body.style.cursor = 'pointer'
        }}
        onPointerOut={() => {
          document.body.style.cursor = 'default'
        }}
      >
        <boxGeometry args={[0.94, 0.1, 0.94]} />
        <meshStandardMaterial color={color} roughness={0.48} metalness={0.05} emissive={emissive} emissiveIntensity={isLegal ? 0.18 : 0} />
      </mesh>
      {isLegal && (
        <mesh position={[0, 0.07, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.12, 0.2, 36]} />
          <meshBasicMaterial color="#84f4bd" transparent opacity={0.78} />
        </mesh>
      )}
    </group>
  )
}

function ChessPiece({
  piece,
  orientation,
  isSelected,
}: {
  piece: BoardPiece
  orientation: 'white' | 'black'
  isSelected: boolean
}) {
  const groupRef = useRef<THREE.Group>(null)
  const { scene } = useGLTF(`/models/gltf/${pieceNames[piece.type]}.glb`)
  const target = squarePosition(piece.square, orientation)

  const model = useMemo(() => {
    const clone = scene.clone(true)
    const material = new THREE.MeshPhysicalMaterial({
      color: piece.color === 'w' ? '#f7eee2' : '#161210',
      roughness: piece.color === 'w' ? 0.46 : 0.38,
      metalness: 0.05,
      clearcoat: 0.28,
      clearcoatRoughness: 0.36,
    })

    clone.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true
        child.receiveShadow = true
        child.material = material
      }
    })

    const box = new THREE.Box3().setFromObject(clone)
    const center = new THREE.Vector3()
    const size = new THREE.Vector3()
    box.getCenter(center)
    box.getSize(size)
    clone.position.set(-center.x, -box.min.y, -center.z)
    const maxFootprint = Math.max(size.x, size.z, 0.001)
    clone.scale.setScalar(0.72 / maxFootprint)

    return clone
  }, [piece.color, scene])

  useFrame((_, delta) => {
    if (!groupRef.current) return

    const desired = new THREE.Vector3(target[0], isSelected ? 0.46 : 0.14, target[2])
    groupRef.current.position.lerp(desired, Math.min(1, delta * 12))
    groupRef.current.rotation.y = THREE.MathUtils.lerp(
      groupRef.current.rotation.y,
      (piece.color === 'w' ? Math.PI : 0) + (orientation === 'black' ? Math.PI : 0),
      Math.min(1, delta * 8),
    )
    groupRef.current.scale.lerp(new THREE.Vector3(isSelected ? 1.08 : 1, isSelected ? 1.08 : 1, isSelected ? 1.08 : 1), Math.min(1, delta * 10))
  })

  return (
    <group ref={groupRef} position={[target[0], 0.14, target[2]]}>
      <primitive object={model} />
    </group>
  )
}

useGLTF.preload('/models/gltf/pawn.glb')
useGLTF.preload('/models/gltf/knight.glb')
useGLTF.preload('/models/gltf/bishop.glb')
useGLTF.preload('/models/gltf/rook.glb')
useGLTF.preload('/models/gltf/queen.glb')
useGLTF.preload('/models/gltf/king.glb')
